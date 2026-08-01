package main

import (
	"compress/flate"
	"context"
	"errors"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"os"
	"path"
	"path/filepath"
	"sync"

	zip "github.com/STARRY-S/zip"
	"github.com/mholt/archives"
)

// Sequential archives are expensive to reopen per page: reaching page N may
// require decoding every entry before it. Materialize RPC-sized pages once in
// archive order, on disk, so normal forward reading pays that cost only once.
const maxArchiveReadCacheBytes int64 = 1 << 30

type archiveReadCacheEntry struct {
	ready    chan struct{}
	path     string
	demanded bool
	finished bool
}

type archiveReadCache struct {
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	dir     string
	entries map[string]*archiveReadCacheEntry
	mu      sync.Mutex
	wake    *sync.Cond
	demand  int
}

func archiveEntryName(name string) string {
	return path.Clean(filepath.ToSlash(name))
}

func (s *archiveSource) enableReadAcceleration() {
	afs, ok := s.fsys.(*archives.ArchiveFS)
	if !ok {
		return
	}

	switch afs.Format.(type) {
	case archives.Zip, *archives.Zip:
		// ZIP already supports true random access. Keep its central directory and
		// underlying file open instead of reconstructing them for every page.
		s.enableDirectZipReads()
	case archives.Rar, *archives.Rar, archives.SevenZip, *archives.SevenZip:
		cache, err := newArchiveReadCache(s.path, afs.Format, s.entries, s.names)
		if err == nil {
			s.readCache = cache
		}
	}
}

func (s *archiveSource) enableDirectZipReads() {
	zr, err := zip.OpenReader(s.path)
	if err != nil {
		return
	}

	byName := make(map[string][]zipDirectEntry)
	for _, file := range zr.File {
		if file.Flags&0x1 != 0 || (file.Method != zip.Store && file.Method != zip.Deflate) {
			continue
		}
		offset, offsetErr := file.DataOffset()
		if offsetErr != nil || file.CompressedSize64 > uint64(^uint64(0)>>1) {
			continue
		}
		name := archiveEntryName(file.Name)
		byName[name] = append(byName[name], zipDirectEntry{
			archivePath:      s.path,
			offset:           offset,
			compressedSize:   int64(file.CompressedSize64),
			uncompressedSize: file.UncompressedSize64,
			method:           file.Method,
			crc32:            file.CRC32,
		})
	}
	_ = zr.Close()

	direct := make(map[string]func() (io.ReadCloser, error))
	used := make(map[string]int)
	for _, rawName := range s.names {
		name := archiveEntryName(rawName)
		files := byName[name]
		if len(files) == 0 {
			continue
		}
		idx := used[name]
		if idx >= len(files) {
			idx = len(files) - 1
		}
		entry := files[idx]
		used[name]++
		direct[rawName] = entry.open
	}
	if len(direct) == 0 {
		return
	}

	s.directOpen = direct
}

type zipDirectEntry struct {
	archivePath      string
	offset           int64
	compressedSize   int64
	uncompressedSize uint64
	method           uint16
	crc32            uint32
}

func (e zipDirectEntry) open() (io.ReadCloser, error) {
	file, err := os.Open(e.archivePath)
	if err != nil {
		return nil, err
	}
	if _, err := file.Seek(e.offset, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, err
	}

	compressed := io.LimitReader(file, e.compressedSize)
	var decoded io.ReadCloser
	switch e.method {
	case zip.Store:
		decoded = io.NopCloser(compressed)
	case zip.Deflate:
		decoded = flate.NewReader(compressed)
	default:
		_ = file.Close()
		return nil, errors.New("unsupported ZIP compression method")
	}
	return &zipPageReader{
		decoded:          decoded,
		file:             file,
		hash:             crc32.NewIEEE(),
		expectedSize:     e.uncompressedSize,
		expectedChecksum: e.crc32,
	}, nil
}

type zipPageReader struct {
	decoded          io.ReadCloser
	file             *os.File
	hash             hash.Hash32
	read             uint64
	expectedSize     uint64
	expectedChecksum uint32
	stickyErr        error
}

func (r *zipPageReader) Read(buf []byte) (int, error) {
	if r.stickyErr != nil {
		return 0, r.stickyErr
	}
	n, err := r.decoded.Read(buf)
	if n > 0 {
		_, _ = r.hash.Write(buf[:n])
		r.read += uint64(n)
		if r.read > r.expectedSize {
			r.stickyErr = errors.New("ZIP entry exceeded declared size")
			return n, r.stickyErr
		}
	}
	if err == io.EOF {
		if r.read != r.expectedSize {
			err = io.ErrUnexpectedEOF
		} else if r.hash.Sum32() != r.expectedChecksum {
			err = errors.New("ZIP entry checksum mismatch")
		}
	}
	if err != nil {
		r.stickyErr = err
	}
	return n, err
}

func (r *zipPageReader) Close() error {
	return errors.Join(r.decoded.Close(), r.file.Close())
}

func newArchiveReadCache(
	archivePath string,
	format archives.Extractor,
	pages []pageEntry,
	names []string,
) (*archiveReadCache, error) {
	dir, err := os.MkdirTemp("", "komika-read-cache-*")
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)

	entries := make(map[string]*archiveReadCacheEntry)
	for i, page := range pages {
		if i >= len(names) || deliveryForPage(page.mime, page.sizeBytes) != deliveryRPC {
			continue
		}
		name := archiveEntryName(names[i])
		if _, exists := entries[name]; !exists {
			entries[name] = &archiveReadCacheEntry{ready: make(chan struct{})}
		}
	}
	if len(entries) == 0 {
		_ = os.RemoveAll(dir)
		return nil, errors.New("archive has no cacheable pages")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cache := &archiveReadCache{
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
		dir:     dir,
		entries: entries,
	}
	cache.wake = sync.NewCond(&cache.mu)
	go cache.populate(archivePath, format)
	return cache, nil
}

func (c *archiveReadCache) populate(archivePath string, format archives.Extractor) {
	defer close(c.done)
	defer func() {
		for _, entry := range c.entries {
			c.finish(entry, "")
		}
	}()

	archiveFile, err := os.Open(archivePath)
	if err != nil {
		return
	}
	defer archiveFile.Close()

	var used int64
	sequence := 0
	_ = format.Extract(c.ctx, archiveFile, func(ctx context.Context, file archives.FileInfo) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if file.IsDir() {
			return nil
		}
		if err := c.waitForDemand(ctx); err != nil {
			return err
		}
		entry := c.entries[archiveEntryName(file.NameInArchive)]
		if entry == nil {
			return nil
		}

		size := file.Size()
		if size < 0 || size > maxArchiveReadCacheBytes-used {
			c.finish(entry, "")
			return nil
		}
		in, openErr := file.Open()
		if openErr != nil {
			c.finish(entry, "")
			return nil
		}

		sequence++
		cachedPath := filepath.Join(c.dir, fmt.Sprintf("%08d.page", sequence))
		out, createErr := os.OpenFile(cachedPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if createErr != nil {
			_ = in.Close()
			c.finish(entry, "")
			return nil
		}

		written, copyErr := copyArchiveCacheFile(ctx, out, in, size)
		closeOutErr := out.Close()
		closeInErr := in.Close()
		if copyErr != nil || closeOutErr != nil || closeInErr != nil || written != size {
			_ = os.Remove(cachedPath)
			c.finish(entry, "")
			return nil
		}

		used += written
		c.finish(entry, cachedPath)
		return nil
	})
}

func (c *archiveReadCache) waitForDemand(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for c.demand == 0 && ctx.Err() == nil {
		c.wake.Wait()
	}
	return ctx.Err()
}

func (c *archiveReadCache) finish(entry *archiveReadCacheEntry, cachedPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry.finished {
		return
	}
	entry.path = cachedPath
	entry.finished = true
	if entry.demanded {
		entry.demanded = false
		c.demand--
	}
	close(entry.ready)
	c.wake.Broadcast()
}

func copyArchiveCacheFile(ctx context.Context, dst io.Writer, src io.Reader, size int64) (int64, error) {
	if size < 0 {
		return 0, errors.New("negative archive entry size")
	}
	limited := io.LimitReader(src, size+1)
	buf := make([]byte, copyChunkSize)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		n, readErr := limited.Read(buf)
		if n > 0 {
			if written+int64(n) > size {
				return written, errors.New("archive entry exceeded declared size")
			}
			wn, writeErr := dst.Write(buf[:n])
			written += int64(wn)
			if writeErr != nil {
				return written, writeErr
			}
			if wn != n {
				return written, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func (c *archiveReadCache) waitPath(name string) (string, error) {
	entry := c.entries[archiveEntryName(name)]
	if entry == nil {
		return "", nil
	}
	c.mu.Lock()
	if entry.finished {
		cachedPath := entry.path
		c.mu.Unlock()
		return cachedPath, nil
	}
	if !entry.demanded {
		entry.demanded = true
		c.demand++
		c.wake.Broadcast()
	}
	c.mu.Unlock()
	select {
	case <-entry.ready:
		c.mu.Lock()
		cachedPath := entry.path
		c.mu.Unlock()
		return cachedPath, nil
	case <-c.ctx.Done():
		return "", c.ctx.Err()
	}
}

func (c *archiveReadCache) Close() {
	if c == nil {
		return
	}
	c.cancel()
	c.mu.Lock()
	c.wake.Broadcast()
	c.mu.Unlock()
	<-c.done
	_ = os.RemoveAll(c.dir)
}
