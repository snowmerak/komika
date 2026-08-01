package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/mholt/archives"
	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

const (
	sourceTypeArchive = "archive"
	sourceTypeFolder  = "folder"
	sourceTypeMedia   = "media"
	maxPageBytes      = 32 << 20
)

var supportedMediaExts = map[string]string{
	".jpg":      "image/jpeg",
	".jpeg":     "image/jpeg",
	".png":      "image/png",
	".webp":     "image/webp",
	".gif":      "image/gif",
	".webm":     "video/webm",
	".mp4":      "video/mp4",
	".mov":      "video/quicktime",
	".mp3":      "audio/mpeg",
	".m4a":      "audio/mp4",
	".aac":      "audio/aac",
	".ogg":      "audio/ogg",
	".opus":     "audio/opus",
	".wav":      "audio/wav",
	".pdf":      "application/pdf",
	".md":       "text/markdown",
	".markdown": "text/markdown",
}

var supportedArchiveExts = map[string]struct{}{
	".cbz": {},
	".zip": {},
	".cbr": {},
	".rar": {},
	".cb7": {},
	".7z":  {},
}

var (
	errNoSupportedMedia   = errors.New("no supported image or video entries found")
	errNoActiveComic      = errors.New("no comic is open")
	errPageOutOfRange     = errors.New("page index out of range")
	errPageTooLarge       = errors.New("media entry exceeds 32 MiB limit")
	errUnsupportedArchive = errors.New("unsupported comic archive format")
	errUnsupportedSource  = errors.New("unsupported file type")
)

// PageDescriptor is the bridge-visible per-page media metadata.
type PageDescriptor struct {
	Mime         string `json:"mime"`
	Delivery     string `json:"delivery"` // "rpc" | "stream"
	SizeBytes    int64  `json:"sizeBytes,omitempty"`
	DocumentPage int    `json:"documentPage,omitempty"` // 1-based; omit/0 if not multi-page doc
	DocumentKey  string `json:"documentKey,omitempty"`
}

// delivery modes for page payload transport.
const (
	deliveryRPC    = "rpc"
	deliveryStream = "stream"
)

// pageStream describes how to open a page for streaming or bounded RPC reads.
type pageStream struct {
	mime      string
	sizeBytes int64
	modTime   time.Time
	// path is the canonical filesystem path for folder/standalone media.
	// Empty for archive members, which must be opened via open.
	path string
	open func() (io.ReadCloser, error)
}

// Comic is the bridge-visible open-work summary.
type Comic struct {
	Title       string           `json:"title"`
	SourceType  string           `json:"sourceType"` // "archive" | "folder" | "media"
	PageCount   int              `json:"pageCount"`
	CurrentPage int              `json:"currentPage"` // zero-based
	Pages       []PageDescriptor `json:"pages"`
}

// PagePayload is a single page binary payload for the reader.
type PagePayload struct {
	Index int    `json:"index"`
	Mime  string `json:"mime"`
	Data  []byte `json:"data"`
}

// pageSource is the single active comic backend.
type pageSource interface {
	Title() string
	SourceType() string
	Path() string
	PageCount() int
	PageDescriptor(index int) PageDescriptor
	StreamPage(index int) (pageStream, error)
	ReadPage(index int) (mime string, data []byte, err error)
	Close() error
}

type pageEntry struct {
	// rel is the slash-normalized relative path used for ordering/display.
	rel string
	// sortKey is the lowercased form of rel used for natural comparisons.
	sortKey string
	// mime is the resolved media MIME for this entry.
	mime string
	// sizeBytes is the declared entry size used for delivery selection.
	sizeBytes int64
	// documentPage is 1-based page index inside a multi-page document (PDF).
	// 0 means the entry is a whole-file media page (image/video/audio/markdown).
	documentPage int
	// documentKey identifies the underlying file for shared document loads.
	// Empty when documentPage == 0. For PDF pages: slash-normalized rel path of the PDF.
	documentKey string
}

type archiveSource struct {
	path    string
	title   string
	fsys    fs.FS
	entries []pageEntry
	// names maps page index -> fs path within the archive.
	names []string
	// directOpen avoids rebuilding a random-access archive index for every page.
	directOpen map[string]func() (io.ReadCloser, error)
	// readCache materializes sequential/solid archive entries in one background pass.
	readCache *archiveReadCache
}

type folderSource struct {
	path  string
	title string
	// kind is sourceTypeFolder or sourceTypeMedia for one-entry media files.
	kind    string
	entries []pageEntry
	// absPaths maps page index -> absolute file path.
	absPaths []string
}

func openPageSource(path string) (pageSource, error) {
	canonical, err := canonicalizePath(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(canonical)
	if err != nil {
		return nil, err
	}

	if info.IsDir() {
		return openFolderSource(canonical)
	}
	if isSupportedMedia(filepath.Base(canonical)) {
		return openMediaSource(canonical, info)
	}
	if isSupportedArchiveExt(canonical) {
		return openArchiveSource(canonical)
	}
	return nil, errUnsupportedSource
}

func canonicalizePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// Fall back to absolute path when the leaf does not yet resolve
		// (e.g. race between listing and open). Library keys still use Abs.
		if os.IsNotExist(err) {
			return abs, nil
		}
		return "", err
	}
	return resolved, nil
}

func isSupportedArchiveExt(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	_, ok := supportedArchiveExts[ext]
	return ok
}

func openArchiveSource(path string) (*archiveSource, error) {
	if !isSupportedArchiveExt(path) {
		return nil, errUnsupportedArchive
	}

	fsys, err := archives.FileSystem(context.Background(), path, nil)
	if err != nil {
		return nil, fmt.Errorf("open archive: %w", err)
	}
	if _, ok := fsys.(*archives.ArchiveFS); !ok {
		// FileSystem returns FileFS for ordinary files and DirFS for directories.
		return nil, errUnsupportedArchive
	}

	type candidate struct {
		entry pageEntry
		name  string
	}
	var cands []candidate
	err = fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		base := filepath.Base(name)
		if !isSupportedMedia(base) {
			return nil
		}
		rel := slashNormalize(name)
		if rel == "." {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return fmt.Errorf("archive entry metadata for %s: %w", name, infoErr)
		}
		size := info.Size()
		mime := mimeForName(base)
		baseEntry := pageEntry{
			rel:       rel,
			sortKey:   strings.ToLower(rel),
			mime:      mime,
			sizeBytes: size,
		}
		if mime == "application/pdf" {
			n, countErr := pdfPageCountFromFS(fsys, name, size)
			if countErr != nil || n < 1 {
				// Skip unreadable PDFs inside multi-entry sources.
				return nil
			}
			for page := 1; page <= n; page++ {
				e := baseEntry
				e.documentPage = page
				e.documentKey = rel
				cands = append(cands, candidate{entry: e, name: name})
			}
			return nil
		}
		cands = append(cands, candidate{entry: baseEntry, name: name})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("open archive: %w", err)
	}
	if len(cands) == 0 {
		return nil, errNoSupportedMedia
	}

	sortPageCandidates(cands, func(i int) pageEntry { return cands[i].entry })

	entries := make([]pageEntry, len(cands))
	names := make([]string, len(cands))
	for i, c := range cands {
		entries[i] = c.entry
		names[i] = c.name
	}

	src := &archiveSource{
		path:    path,
		title:   titleFromPath(path),
		fsys:    fsys,
		entries: entries,
		names:   names,
	}
	src.enableReadAcceleration()
	return src, nil
}

func openFolderSource(path string) (*folderSource, error) {
	type candidate struct {
		entry   pageEntry
		absPath string
	}
	var cands []candidate

	err := filepath.WalkDir(path, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			// Never follow directory symlinks.
			if p != path {
				info, err := d.Info()
				if err != nil {
					return err
				}
				if info.Mode()&os.ModeSymlink != 0 {
					return filepath.SkipDir
				}
				// WalkDir already doesn't follow symlinks for dirs on most platforms
				// when using the dir entry; still skip symlink dirs explicitly.
				if (info.Mode() & fs.ModeSymlink) != 0 {
					return filepath.SkipDir
				}
			}
			return nil
		}
		// Skip non-regular files and unsupported extensions.
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if !isSupportedMedia(d.Name()) {
			return nil
		}
		rel, err := filepath.Rel(path, p)
		if err != nil {
			return err
		}
		rel = slashNormalize(rel)
		mime := mimeForName(d.Name())
		baseEntry := pageEntry{
			rel:       rel,
			sortKey:   strings.ToLower(rel),
			mime:      mime,
			sizeBytes: info.Size(),
		}
		if mime == "application/pdf" {
			n, countErr := pdfPageCountFile(p)
			if countErr != nil || n < 1 {
				// Skip unreadable PDFs inside multi-entry sources.
				return nil
			}
			for page := 1; page <= n; page++ {
				e := baseEntry
				e.documentPage = page
				e.documentKey = rel
				cands = append(cands, candidate{entry: e, absPath: p})
			}
			return nil
		}
		cands = append(cands, candidate{entry: baseEntry, absPath: p})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(cands) == 0 {
		return nil, errNoSupportedMedia
	}

	sort.SliceStable(cands, func(i, j int) bool {
		return pageEntryLess(cands[i].entry, cands[j].entry)
	})

	entries := make([]pageEntry, len(cands))
	absPaths := make([]string, len(cands))
	for i, c := range cands {
		entries[i] = c.entry
		absPaths[i] = c.absPath
	}

	return &folderSource{
		path:     path,
		title:    titleFromPath(path),
		kind:     sourceTypeFolder,
		entries:  entries,
		absPaths: absPaths,
	}, nil
}

func openMediaSource(path string, info os.FileInfo) (*folderSource, error) {
	if !info.Mode().IsRegular() {
		return nil, errUnsupportedSource
	}
	base := filepath.Base(path)
	if !isSupportedMedia(base) {
		return nil, errUnsupportedSource
	}
	rel := base
	mime := mimeForName(base)
	baseEntry := pageEntry{
		rel:       rel,
		sortKey:   strings.ToLower(rel),
		mime:      mime,
		sizeBytes: info.Size(),
	}

	var entries []pageEntry
	var absPaths []string
	if mime == "application/pdf" {
		n, err := pdfPageCountFile(path)
		if err != nil {
			return nil, fmt.Errorf("could not open PDF: %w", err)
		}
		if n < 1 {
			return nil, fmt.Errorf("could not open PDF: no pages")
		}
		entries = make([]pageEntry, n)
		absPaths = make([]string, n)
		for page := 1; page <= n; page++ {
			e := baseEntry
			e.documentPage = page
			e.documentKey = rel
			entries[page-1] = e
			absPaths[page-1] = path
		}
	} else {
		entries = []pageEntry{baseEntry}
		absPaths = []string{path}
	}

	return &folderSource{
		path:     path,
		title:    titleFromPath(path),
		kind:     sourceTypeMedia,
		entries:  entries,
		absPaths: absPaths,
	}, nil
}

func (s *archiveSource) Title() string      { return s.title }
func (s *archiveSource) SourceType() string { return sourceTypeArchive }
func (s *archiveSource) Path() string       { return s.path }
func (s *archiveSource) PageCount() int     { return len(s.entries) }

func deliveryForSize(sizeBytes int64) string {
	if sizeBytes > maxPageBytes {
		return deliveryStream
	}
	return deliveryRPC
}

// video/audio always stream: WebKitGTK fails on large H.264 blob: URLs even when
// the same bytes play over HTTP (verified MiniBrowser A/B on 4K H.264).
func deliveryForPage(mime string, sizeBytes int64) string {
	if forcesStreamDelivery(mime) {
		return deliveryStream
	}
	return deliveryForSize(sizeBytes)
}

func forcesStreamDelivery(mime string) bool {
	lower := strings.ToLower(strings.TrimSpace(mime))
	return strings.HasPrefix(lower, "video/") || strings.HasPrefix(lower, "audio/")
}

func (s *archiveSource) PageDescriptor(index int) PageDescriptor {
	if index < 0 || index >= len(s.entries) {
		return PageDescriptor{}
	}
	e := s.entries[index]
	return pageDescriptorFromEntry(e)
}

func (s *archiveSource) StreamPage(index int) (pageStream, error) {
	if index < 0 || index >= len(s.entries) {
		return pageStream{}, errPageOutOfRange
	}
	e := s.entries[index]
	name := s.names[index]
	if open := s.directOpen[name]; open != nil {
		return pageStream{
			mime:      e.mime,
			sizeBytes: e.sizeBytes,
			open:      open,
		}, nil
	}
	if s.readCache != nil {
		cachedPath, err := s.readCache.waitPath(name)
		if err != nil {
			return pageStream{}, err
		}
		if cachedPath != "" {
			var modTime time.Time
			if info, statErr := os.Stat(cachedPath); statErr == nil {
				modTime = info.ModTime()
			}
			return pageStream{
				mime:      e.mime,
				sizeBytes: e.sizeBytes,
				modTime:   modTime,
				path:      cachedPath,
				open: func() (io.ReadCloser, error) {
					return os.Open(cachedPath)
				},
			}, nil
		}
	}
	return pageStream{
		mime:      e.mime,
		sizeBytes: e.sizeBytes,
		open: func() (io.ReadCloser, error) {
			return s.fsys.Open(name)
		},
	}, nil
}

func (s *archiveSource) ReadPage(index int) (string, []byte, error) {
	ps, err := s.StreamPage(index)
	if err != nil {
		return "", nil, err
	}
	file, err := ps.open()
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	data, err := readLimited(file, maxPageBytes)
	if err != nil {
		return "", nil, err
	}
	return ps.mime, data, nil
}

func (s *archiveSource) Close() error {
	if s.readCache != nil {
		s.readCache.Close()
		s.readCache = nil
	}
	s.directOpen = nil
	// archives.ArchiveFS is path-backed and has no Close method.
	s.fsys = nil
	return nil
}

func (s *folderSource) Title() string { return s.title }
func (s *folderSource) SourceType() string {
	if s.kind == sourceTypeMedia {
		return sourceTypeMedia
	}
	return sourceTypeFolder
}
func (s *folderSource) Path() string   { return s.path }
func (s *folderSource) PageCount() int { return len(s.entries) }

func (s *folderSource) PageDescriptor(index int) PageDescriptor {
	if index < 0 || index >= len(s.entries) {
		return PageDescriptor{}
	}
	e := s.entries[index]
	return pageDescriptorFromEntry(e)
}

func (s *folderSource) StreamPage(index int) (pageStream, error) {
	if index < 0 || index >= len(s.entries) {
		return pageStream{}, errPageOutOfRange
	}
	e := s.entries[index]
	abs := s.absPaths[index]
	var modTime time.Time
	if info, err := os.Stat(abs); err == nil {
		modTime = info.ModTime()
	}
	return pageStream{
		mime:      e.mime,
		sizeBytes: e.sizeBytes,
		modTime:   modTime,
		path:      abs,
		open: func() (io.ReadCloser, error) {
			return os.Open(abs)
		},
	}, nil
}

func (s *folderSource) ReadPage(index int) (string, []byte, error) {
	ps, err := s.StreamPage(index)
	if err != nil {
		return "", nil, err
	}
	f, err := ps.open()
	if err != nil {
		return "", nil, err
	}
	defer f.Close()
	data, err := readLimited(f, maxPageBytes)
	if err != nil {
		return "", nil, err
	}
	return ps.mime, data, nil
}

func (s *folderSource) Close() error { return nil }

func encodePagePayload(index int, mime string, data []byte) *PagePayload {
	return &PagePayload{
		Index: index,
		Mime:  mime,
		Data:  data,
	}
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errPageTooLarge
	}
	return data, nil
}

func isSupportedMedia(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	_, ok := supportedMediaExts[ext]
	return ok
}

func mimeForName(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if mime, ok := supportedMediaExts[ext]; ok {
		return mime
	}
	return "application/octet-stream"
}

func pageDescriptorFromEntry(e pageEntry) PageDescriptor {
	return PageDescriptor{
		Mime:         e.mime,
		Delivery:     deliveryForPage(e.mime, e.sizeBytes),
		SizeBytes:    e.sizeBytes,
		DocumentPage: e.documentPage,
		DocumentKey:  e.documentKey,
	}
}

func pageEntryLess(a, b pageEntry) bool {
	if a.sortKey != b.sortKey {
		return naturalLess(a.sortKey, b.sortKey, a.rel, b.rel)
	}
	if a.documentPage != b.documentPage {
		return a.documentPage < b.documentPage
	}
	return a.rel < b.rel
}

// sortPageCandidates sorts archive candidates by pageEntryLess.
// entryAt extracts the pageEntry for index i from the underlying slice.
func sortPageCandidates[T any](cands []T, entryAt func(int) pageEntry) {
	sort.SliceStable(cands, func(i, j int) bool {
		return pageEntryLess(entryAt(i), entryAt(j))
	})
}

func pdfPageCountFile(path string) (int, error) {
	n, err := pdfcpuapi.PageCountFile(path)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// pdfPageCountFromFS materializes an archive member to a temp file, counts pages, then deletes the temp.
func pdfPageCountFromFS(fsys fs.FS, name string, size int64) (int, error) {
	// Cap temp materialization similarly to stream reads (2 GiB mindset not needed for count;
	// still avoid unbounded reads — use max of file size if known, else stream copy).
	f, err := fsys.Open(name)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// Prefer ReadSeeker path without temp when available.
	if rs, ok := f.(io.ReadSeeker); ok {
		return pdfcpuapi.PageCount(rs, model.NewDefaultConfiguration())
	}

	tmp, err := os.CreateTemp("", "komika-pdf-*")
	if err != nil {
		return 0, err
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()

	// Bound copy: reuse maxPageBytes*64 (~2GiB) only as safety; prefer declared size.
	limit := int64(2 << 30)
	if size > 0 && size < limit {
		limit = size
	}
	written, err := io.Copy(tmp, io.LimitReader(f, limit+1))
	if err != nil {
		return 0, err
	}
	if written > limit {
		return 0, fmt.Errorf("pdf member too large to count")
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}
	return pdfPageCountFile(tmpPath)
}

func titleFromPath(path string) string {
	base := filepath.Base(path)
	ext := strings.ToLower(filepath.Ext(base))
	if _, ok := supportedArchiveExts[ext]; ok {
		return strings.TrimSuffix(base, filepath.Ext(base))
	}
	return base
}

func slashNormalize(p string) string {
	return filepath.ToSlash(p)
}

// naturalLess compares lowercased keys with numeric-run awareness.
// When keys compare equal under natural rules, original paths break the tie.
func naturalLess(aKey, bKey, aOrig, bOrig string) bool {
	cmp := naturalCompare(aKey, bKey)
	if cmp < 0 {
		return true
	}
	if cmp > 0 {
		return false
	}
	return aOrig < bOrig
}

func naturalCompare(a, b string) int {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ar, as := a[i], unicode.IsDigit(rune(a[i]))
		br, bs := b[j], unicode.IsDigit(rune(b[j]))
		_ = ar
		_ = br
		if as && bs {
			// Consume full digit runs; compare by numeric value then length for leading zeros.
			ai, an := readDigits(a, i)
			bi, bn := readDigits(b, j)
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
			// Equal numeric value: shorter digit run (fewer leading zeros) first via original run length.
			aRun := a[i:ai]
			bRun := b[j:bi]
			if aRun != bRun {
				if len(aRun) != len(bRun) {
					if len(aRun) < len(bRun) {
						return -1
					}
					return 1
				}
				if aRun < bRun {
					return -1
				}
				return 1
			}
			i, j = ai, bi
			continue
		}
		if as != bs {
			// Digits vs non-digits: byte order of current chars.
			if a[i] < b[j] {
				return -1
			}
			if a[i] > b[j] {
				return 1
			}
		}
		if a[i] != b[j] {
			if a[i] < b[j] {
				return -1
			}
			return 1
		}
		i++
		j++
	}
	switch {
	case i == len(a) && j == len(b):
		return 0
	case i == len(a):
		return -1
	default:
		return 1
	}
}

func readDigits(s string, start int) (end int, value uint64) {
	end = start
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	// Parse without leading-zero sensitivity for value; overflow falls back to lexical via strconv.
	n, err := strconv.ParseUint(s[start:end], 10, 64)
	if err != nil {
		// Extremely long digit run: treat as max and rely on run-length tie-break.
		return end, ^uint64(0)
	}
	return end, n
}

// pageNames returns ordered relative paths (for tests).
func pageNames(src pageSource) []string {
	switch s := src.(type) {
	case *archiveSource:
		out := make([]string, len(s.entries))
		for i, e := range s.entries {
			out[i] = e.rel
		}
		return out
	case *folderSource:
		out := make([]string, len(s.entries))
		for i, e := range s.entries {
			out[i] = e.rel
		}
		return out
	default:
		return nil
	}
}

// pageDescriptors returns ordered page descriptors from a source.
func pageDescriptors(src pageSource) []PageDescriptor {
	n := src.PageCount()
	out := make([]PageDescriptor, n)
	for i := 0; i < n; i++ {
		out[i] = src.PageDescriptor(i)
	}
	return out
}
