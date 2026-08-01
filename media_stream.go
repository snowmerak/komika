package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	defaultMaxArchiveStreamBytes = 2 << 30
	defaultMaxArchiveTempBytes   = 2 << 30
	mediaPathPrefix              = "/media/"
	copyChunkSize                = 256 << 10
)

var (
	errNotStreamPage         = errors.New("page does not use stream delivery")
	errArchiveStreamTooLarge = errors.New("oversized archive media exceeds the 2 GiB streaming limit")
	errArchiveTempCacheFull  = errors.New("oversized archive media exceeds the available 2 GiB streaming cache")
	errArchiveStreamPrepare  = errors.New("could not prepare archive media for streaming")
)

// PageStream is the bridge-visible capability URL for oversized media.
type PageStream struct {
	URL   string `json:"url"`            // relative: "/media/<token>"
	Token string `json:"token"`          // opaque capability; never a path or page index
	Mime  string `json:"mime,omitempty"` // optional resolved MIME (e.g. after transcode)
}

type sourceSlot struct {
	source     pageSource
	generation uint64
	leases     int
	retired    bool
}

type streamEntry struct {
	generation uint64
	path       string
	mime       string
	modTime    time.Time
	temporary  bool
	ownedBytes int64
	refs       int
	retired    bool
}

func initStreamState(s *ComicService) {
	if s.streams == nil {
		s.streams = make(map[string]*streamEntry)
	}
	if s.maxArchiveStreamBytes == 0 {
		s.maxArchiveStreamBytes = defaultMaxArchiveStreamBytes
	}
	if s.maxArchiveTempBytes == 0 {
		s.maxArchiveTempBytes = defaultMaxArchiveTempBytes
	}
}

func (s *ComicService) acquireSourceLease() (*sourceSlot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil || s.active.source == nil {
		return nil, errNoActiveComic
	}
	s.active.leases++
	return s.active, nil
}

func (s *ComicService) releaseSourceLease(slot *sourceSlot) {
	if slot == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	slot.leases--
	if slot.leases < 0 {
		slot.leases = 0
	}
	if slot.retired && slot.leases == 0 && slot.source != nil {
		_ = slot.source.Close()
		slot.source = nil
	}
}

func (s *ComicService) retireActiveLocked() {
	if s.active == nil {
		return
	}
	s.invalidateStreamsLocked()
	s.invalidateTranscodeCacheLocked()
	s.invalidateUpscaleCacheLocked()
	old := s.active
	old.retired = true
	s.active = nil
	if old.leases == 0 && old.source != nil {
		_ = old.source.Close()
		old.source = nil
	}
}

func (s *ComicService) promoteSourceLocked(src pageSource) {
	s.nextGeneration++
	s.active = &sourceSlot{
		source:     src,
		generation: s.nextGeneration,
		leases:     0,
		retired:    false,
	}
}

// GetPageStream mints a same-origin capability URL for streaming media.
// Images/PDF/markdown still require delivery=stream (size gate). Video/audio
// always allowed so the reader never feeds WebKit a blob: of H.264.
func (s *ComicService) GetPageStream(index int) (*PageStream, error) {
	initStreamState(s)

	slot, err := s.acquireSourceLease()
	if err != nil {
		return nil, err
	}
	defer s.releaseSourceLease(slot)

	src := slot.source
	if index < 0 || index >= src.PageCount() {
		return nil, errPageOutOfRange
	}
	desc := src.PageDescriptor(index)
	if desc.Delivery != deliveryStream && !forcesStreamDelivery(desc.Mime) {
		return nil, errNotStreamPage
	}
	ps, err := src.StreamPage(index)
	if err != nil {
		return nil, err
	}

	var (
		streamPath string
		modTime    time.Time
		temporary  bool
		ownedBytes int64
		pending    int64
	)

	if ps.path != "" {
		// Direct folder/standalone: stream from the canonical source file.
		streamPath = ps.path
		modTime = ps.modTime
		if modTime.IsZero() {
			if info, statErr := os.Stat(streamPath); statErr == nil {
				modTime = info.ModTime()
			}
		}
	} else {
		// Archive members must be materialized to a seekable temp file.
		prepared, prepErr := s.materializeArchiveStream(ps)
		if prepErr != nil {
			return nil, prepErr
		}
		streamPath = prepared.path
		modTime = prepared.modTime
		temporary = true
		ownedBytes = prepared.ownedBytes
		pending = prepared.pendingReleased
	}
	_ = pending

	// WebKitGTK often black-screens on non-faststart MP4 over HTTP (moov at end).
	// Phone camera exports (Android mp42) commonly need a cheap remux first.
	if ps.mime == "video/mp4" || ps.mime == "video/quicktime" {
		fast, fsErr := mp4MoovBeforeMdat(streamPath)
		if fsErr == nil && !fast && shouldEagerFaststartRemux(runtime.GOOS) {
			fixed, fixErr := s.ensureFaststartMP4(streamPath)
			if fixErr != nil {
				log.Printf("komika: faststart remux skipped: %v", fixErr)
			} else if fixed != nil {
				log.Printf("komika: auto faststart remux for %s", streamPath)
				prevPath, prevTemp, prevOwned := streamPath, temporary, ownedBytes
				s.mu.Lock()
				if prevTemp && prevPath != "" {
					// Drop prior temp reservation before adopting the replacement.
					s.archiveTempBytes -= prevOwned
					if s.archiveTempBytes < 0 {
						s.archiveTempBytes = 0
					}
				}
				// Refuse if cache would exceed cap (standalone faststart still uses this budget).
				if s.maxArchiveTempBytes > 0 && s.archiveTempBytes+fixed.size > s.maxArchiveTempBytes {
					s.mu.Unlock()
					removeFaststartTree(fixed.path)
					log.Printf("komika: faststart remux dropped: temp cache full")
				} else {
					s.archiveTempBytes += fixed.size
					s.mu.Unlock()
					if prevTemp && prevPath != "" && prevPath != fixed.path {
						removeFaststartTree(prevPath)
						_ = os.Remove(prevPath) // non-faststart temps are plain files
					}
					streamPath = fixed.path
					temporary = true
					ownedBytes = fixed.size
					if info, e := os.Stat(streamPath); e == nil {
						modTime = info.ModTime()
					}
				}
			}
		}
	}

	token, err := mintStreamToken()
	if err != nil {
		if temporary {
			s.releaseTempReservation(ownedBytes)
			removeFaststartTree(streamPath)
			_ = os.Remove(streamPath)
		}
		return nil, err
	}

	s.mu.Lock()
	if s.active == nil || s.active.generation != slot.generation {
		if temporary {
			s.archiveTempBytes -= ownedBytes
			if s.archiveTempBytes < 0 {
				s.archiveTempBytes = 0
			}
			// unlock before filesystem IO
			path := streamPath
			s.mu.Unlock()
			removeFaststartTree(path)
			_ = os.Remove(path)
			return nil, errNoActiveComic
		}
		s.mu.Unlock()
		return nil, errNoActiveComic
	}

	s.streams[token] = &streamEntry{
		generation: slot.generation,
		path:       streamPath,
		mime:       ps.mime,
		modTime:    modTime,
		temporary:  temporary,
		ownedBytes: ownedBytes,
		refs:       0,
		retired:    false,
	}
	s.mu.Unlock()

	url, err := s.mediaStreamURL(token)
	if err != nil {
		// Roll back the token entry (and temp file) if loopback HTTP cannot start.
		_ = s.ReleasePageStream(token)
		return nil, err
	}
	return &PageStream{
		URL:   url,
		Token: token,
	}, nil
}

type materializeResult struct {
	path            string
	modTime         time.Time
	ownedBytes      int64
	pendingReleased int64
}

func (s *ComicService) materializeArchiveStream(ps pageStream) (*materializeResult, error) {
	rc, err := ps.open()
	if err != nil {
		return nil, errArchiveStreamPrepare
	}
	defer rc.Close()

	tmp, err := os.CreateTemp("", "komika-media-*")
	if err != nil {
		return nil, errArchiveStreamPrepare
	}
	tmpPath := tmp.Name()
	_ = tmp.Chmod(0o600)

	var (
		copied  int64
		pending int64
		buf     = make([]byte, copyChunkSize)
	)

	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		if pending > 0 {
			s.releasePendingReservation(pending)
			pending = 0
		}
	}

	for {
		n, readErr := rc.Read(buf)
		if n > 0 {
			chunk := int64(n)
			if copied+chunk > s.maxArchiveStreamBytes {
				cleanup()
				return nil, errArchiveStreamTooLarge
			}
			if !s.reserveArchiveTemp(chunk) {
				cleanup()
				return nil, errArchiveTempCacheFull
			}
			pending += chunk
			if _, writeErr := tmp.Write(buf[:n]); writeErr != nil {
				cleanup()
				return nil, errArchiveStreamPrepare
			}
			copied += chunk
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			cleanup()
			return nil, errArchiveStreamPrepare
		}
	}

	if err := tmp.Close(); err != nil {
		s.releasePendingReservation(pending)
		_ = os.Remove(tmpPath)
		return nil, errArchiveStreamPrepare
	}

	// Convert pending reservation into owned bytes under the mutex.
	s.mu.Lock()
	s.archiveTempPendingBytes -= pending
	if s.archiveTempPendingBytes < 0 {
		s.archiveTempPendingBytes = 0
	}
	s.archiveTempBytes += copied
	s.mu.Unlock()

	info, _ := os.Stat(tmpPath)
	modTime := time.Now()
	if info != nil {
		modTime = info.ModTime()
	}

	return &materializeResult{
		path:            tmpPath,
		modTime:         modTime,
		ownedBytes:      copied,
		pendingReleased: 0,
	}, nil
}

func (s *ComicService) reserveArchiveTemp(chunk int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archiveTempBytes+s.archiveTempPendingBytes+chunk > s.maxArchiveTempBytes {
		return false
	}
	s.archiveTempPendingBytes += chunk
	return true
}

func (s *ComicService) releasePendingReservation(pending int64) {
	if pending <= 0 {
		return
	}
	s.mu.Lock()
	s.archiveTempPendingBytes -= pending
	if s.archiveTempPendingBytes < 0 {
		s.archiveTempPendingBytes = 0
	}
	s.mu.Unlock()
}

func (s *ComicService) releaseTempReservation(owned int64) {
	if owned <= 0 {
		return
	}
	s.mu.Lock()
	s.archiveTempBytes -= owned
	if s.archiveTempBytes < 0 {
		s.archiveTempBytes = 0
	}
	s.mu.Unlock()
}

// ReleasePageStream removes an active stream capability token.
func (s *ComicService) ReleasePageStream(token string) error {
	if token == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.streams[token]
	if !ok {
		return nil
	}
	delete(s.streams, token)
	s.retireStreamEntryLocked(entry)
	return nil
}

func (s *ComicService) invalidateStreamsLocked() {
	for token, entry := range s.streams {
		delete(s.streams, token)
		s.retireStreamEntryLocked(entry)
	}
}

func (s *ComicService) retireStreamEntryLocked(entry *streamEntry) {
	if entry == nil || entry.retired {
		return
	}
	entry.retired = true
	if entry.refs > 0 {
		// Final handler release removes the file and frees the budget.
		return
	}
	s.removeStreamArtifactLocked(entry)
}

func (s *ComicService) removeStreamArtifactLocked(entry *streamEntry) {
	if entry.temporary && entry.path != "" {
		path := entry.path
		owned := entry.ownedBytes
		entry.ownedBytes = 0
		entry.path = ""
		s.archiveTempBytes -= owned
		if s.archiveTempBytes < 0 {
			s.archiveTempBytes = 0
		}
		// filesystem IO without holding semantics beyond accounting — caller holds mu.
		removeFaststartTree(path)
		_ = os.Remove(path)
	}
}

func (s *ComicService) acquireStreamEntry(token string) (*streamEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.streams[token]
	if !ok || entry.retired {
		return nil, errNoActiveComic
	}
	if s.active == nil || s.active.generation != entry.generation {
		return nil, errNoActiveComic
	}
	entry.refs++
	return entry, nil
}

func (s *ComicService) releaseStreamEntry(entry *streamEntry) {
	if entry == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.refs--
	if entry.refs < 0 {
		entry.refs = 0
	}
	if entry.retired && entry.refs == 0 {
		s.removeStreamArtifactLocked(entry)
	}
}

// ServiceShutdown cleans up stream tokens and active source on app exit.
func (s *ComicService) ServiceShutdown() error {
	s.shutdownMediaHTTP()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invalidateStreamsLocked()
	s.retireActiveLocked()
	return nil
}

func mintStreamToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("mint stream token: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

func mediaMiddleware(s *ComicService) application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, mediaPathPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			s.serveMedia(w, r)
		})
	}
}

func (s *ComicService) serveMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	token := path.Base(r.URL.Path)
	// path.Base("/media/") == "media"; require exactly one segment after prefix.
	rest := strings.TrimPrefix(r.URL.Path, mediaPathPrefix)
	if rest == "" || strings.Contains(rest, "/") || token == "" || token == "." || token == "/" {
		http.NotFound(w, r)
		return
	}
	if token != rest {
		http.NotFound(w, r)
		return
	}

	entry, err := s.acquireStreamEntry(token)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer s.releaseStreamEntry(entry)

	f, err := os.Open(entry.path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// Prefer live file Stat for range/conditional metadata.
	modTime := info.ModTime()

	w.Header().Set("Content-Type", entry.mime)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", modTime, f)
}
