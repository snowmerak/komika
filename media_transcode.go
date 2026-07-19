package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultMaxTranscodeTempBytes = 2 << 30
	transcodeProfileWebM         = "webm-vp8-opus-rt-v5-scale1280"
	transcodeProfileRemuxMP4     = "mp4-copy-clean-v1"
	transcodeAudioProfile        = "ogg-opus-v1"
)

var (
	errTranscodeUnsupported = errors.New("page is not video or audio")
	errFFmpegUnavailable    = errors.New("ffmpeg not found on PATH; install ffmpeg to play this media")
	errTranscodeFailed      = errors.New("could not transcode media for playback")
	errTranscodeCacheFull   = errors.New("transcode cache is full")
	errTranscodeCanceled    = errors.New("transcode canceled")
)

// lookFFmpegPath resolves the ffmpeg binary. Tests may override.
// Order: $FFMPEG → PATH → common absolute locations (GUI apps often have a short PATH).
var lookFFmpegPath = func() (string, error) {
	return resolveFFmpegPath()
}

func resolveFFmpegPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("FFMPEG")); p != "" {
		if isExecutableFile(p) {
			return p, nil
		}
		return "", fmt.Errorf("%w: FFMPEG=%q is not an executable file", errFFmpegUnavailable, p)
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p, nil
	}
	// Desktop/AppImage launches often inherit a minimal PATH without brew/user bins.
	candidates := []string{
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/opt/homebrew/bin/ffmpeg",
		"/home/linuxbrew/.linuxbrew/bin/ffmpeg",
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".linuxbrew", "bin", "ffmpeg"),
			filepath.Join(home, ".local", "bin", "ffmpeg"),
		)
	}
	for _, p := range candidates {
		if isExecutableFile(p) {
			return p, nil
		}
	}
	return "", errFFmpegUnavailable
}

func isExecutableFile(path string) bool {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || !st.Mode().IsRegular() {
		return false
	}
	return st.Mode().Perm()&0o111 != 0
}

// runFFmpegCommand runs ffmpeg. Tests may override.
// ctx cancel (source switch / shutdown) kills the process.
// Strips AppImage library overrides so a host ffmpeg does not load bundled libs.
var runFFmpegCommand = func(ctx context.Context, ffmpegPath string, args []string) error {
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	hideConsoleWindow(cmd)
	cmd.Env = sanitizedExecEnv()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return errTranscodeCanceled
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			return fmt.Errorf("%w: %v", errTranscodeFailed, err)
		}
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		return fmt.Errorf("%w: %s", errTranscodeFailed, msg)
	}
	return nil
}

// sanitizedExecEnv is os.Environ without AppImage/loader overrides that break
// host tools resolved outside the bundle (common when spawning /usr or brew ffmpeg).
func sanitizedExecEnv() []string {
	env := os.Environ()
	out := make([]string, 0, len(env))
	for _, e := range env {
		upper := e
		if i := strings.IndexByte(e, '='); i > 0 {
			upper = e[:i]
		}
		switch strings.ToUpper(upper) {
		case "LD_LIBRARY_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_DEBUG",
			"PYTHONHOME", "PYTHONPATH", "GTK_PATH", "GTK_EXE_PREFIX",
			"QT_PLUGIN_PATH", "QML2_IMPORT_PATH":
			continue
		}
		out = append(out, e)
	}
	return out
}

type transcodeCacheEntry struct {
	key        string
	generation uint64
	path       string
	mime       string
	ownedBytes int64
	modTime    time.Time
}

type transcodeFlight struct {
	generation uint64
	done       chan struct{}
	cancel     context.CancelFunc
	entry      *transcodeCacheEntry
	err        error
}

func initTranscodeState(s *ComicService) {
	if s.transcodeCache == nil {
		s.transcodeCache = make(map[string]*transcodeCacheEntry)
	}
	if s.transcodeInflight == nil {
		s.transcodeInflight = make(map[string]*transcodeFlight)
	}
	if s.maxTranscodeTempBytes == 0 {
		s.maxTranscodeTempBytes = defaultMaxTranscodeTempBytes
	}
}

// GetTranscodedStream re-encodes a video/audio page to WebM/Ogg via system ffmpeg.
func (s *ComicService) GetTranscodedStream(index int) (*PageStream, error) {
	return s.getCompatibleStream(index, "reencode")
}

// GetRemuxedStream lossless-copies video/audio tracks into a clean MP4 (drops data
// tracks like tmcd). Fast path when WebKit decodes H.264 briefly then fails.
func (s *ComicService) GetRemuxedStream(index int) (*PageStream, error) {
	return s.getCompatibleStream(index, "remux")
}

// mode: "remux" | "reencode"
func (s *ComicService) getCompatibleStream(index int, mode string) (*PageStream, error) {
	initStreamState(s)
	initTranscodeState(s)

	slot, err := s.acquireSourceLease()
	if err != nil {
		return nil, err
	}
	// Keep lease until ffmpeg finishes and the stream token is registered.
	defer s.releaseSourceLease(slot)

	src := slot.source
	if index < 0 || index >= src.PageCount() {
		return nil, errPageOutOfRange
	}
	desc := src.PageDescriptor(index)
	kind := mediaKindFromMime(desc.Mime)
	if kind != "video" && kind != "audio" {
		return nil, errTranscodeUnsupported
	}
	if mode == "remux" && kind != "video" {
		// Remux path is for container cleanup of video clips.
		return nil, errTranscodeUnsupported
	}

	// Direct source access — works for both rpc and stream delivery pages.
	ps, err := src.StreamPage(index)
	if err != nil {
		return nil, err
	}

	cacheKey, err := s.transcodeCacheKey(slot.generation, index, desc.Mime, ps, mode)
	if err != nil {
		return nil, err
	}

	entry, err := s.getOrCreateTranscode(slot.generation, kind, mode, ps, cacheKey)
	if err != nil {
		return nil, err
	}

	token, err := mintStreamToken()
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	if s.active == nil || s.active.generation != slot.generation {
		s.mu.Unlock()
		return nil, errNoActiveComic
	}
	// Non-temporary: transcode cache owns the file lifetime across tokens.
	s.streams[token] = &streamEntry{
		generation: slot.generation,
		path:       entry.path,
		mime:       entry.mime,
		modTime:    entry.modTime,
		temporary:  false,
		ownedBytes: 0,
		refs:       0,
		retired:    false,
	}
	s.mu.Unlock()

	url, err := s.mediaStreamURL(token)
	if err != nil {
		_ = s.ReleasePageStream(token)
		return nil, err
	}
	return &PageStream{
		URL:   url,
		Token: token,
		Mime:  entry.mime,
	}, nil
}

func (s *ComicService) getOrCreateTranscode(
	generation uint64,
	kind string,
	mode string,
	ps pageStream,
	cacheKey string,
) (*transcodeCacheEntry, error) {
	s.mu.Lock()
	initTranscodeState(s)
	if entry := s.transcodeCache[cacheKey]; entry != nil {
		if _, statErr := os.Stat(entry.path); statErr == nil {
			s.mu.Unlock()
			return entry, nil
		}
		s.removeTranscodeEntryLocked(cacheKey)
	}
	if flight := s.transcodeInflight[cacheKey]; flight != nil {
		s.mu.Unlock()
		<-flight.done
		if flight.err != nil {
			return nil, flight.err
		}
		return flight.entry, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	flight := &transcodeFlight{
		generation: generation,
		done:       make(chan struct{}),
		cancel:     cancel,
	}
	s.transcodeInflight[cacheKey] = flight
	s.mu.Unlock()

	entry, err := s.runTranscode(ctx, generation, kind, mode, ps, cacheKey)

	s.mu.Lock()
	delete(s.transcodeInflight, cacheKey)
	// Drop cancel ref so retire cannot double-cancel after completion.
	flight.cancel = nil
	if err != nil {
		flight.err = err
		close(flight.done)
		s.mu.Unlock()
		cancel()
		return nil, err
	}
	// runTranscode already inserted under the same lock as reserve when generation matched.
	// Re-check in case retire raced after unlock: drop orphan file and fail closed.
	// If invalidate already removed the entry, bytes were freed there — do not double-free.
	if cached := s.transcodeCache[cacheKey]; cached == nil || cached != entry {
		if entry.path != "" {
			_ = os.Remove(entry.path)
		}
		flight.err = errNoActiveComic
		close(flight.done)
		s.mu.Unlock()
		cancel()
		return nil, errNoActiveComic
	}
	flight.entry = entry
	close(flight.done)
	s.mu.Unlock()
	cancel()
	return entry, nil
}

func (s *ComicService) runTranscode(
	ctx context.Context,
	generation uint64,
	kind string,
	mode string,
	ps pageStream,
	cacheKey string,
) (*transcodeCacheEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, errTranscodeCanceled
	}
	ffmpegPath, err := lookFFmpegPath()
	if err != nil {
		log.Printf("komika: ffmpeg unavailable: %v", err)
		return nil, errFFmpegUnavailable
	}
	if mode != "remux" {
		mode = "reencode"
	}
	log.Printf("komika: host ffmpeg mode=%s using %s (kind=%s)", mode, ffmpegPath, kind)

	// Folder/standalone: ps.path. Archive: materialize seekable temp for ffmpeg -i.
	inputPath, cleanupInput, err := s.materializeTranscodeInput(ps)
	if err != nil {
		return nil, err
	}
	if cleanupInput != nil {
		defer cleanupInput()
	}

	outMime, argsTail := transcodeOutputArgs(kind, mode)
	pattern := "komika-tx-*.webm"
	switch {
	case kind == "audio":
		pattern = "komika-tx-*.ogg"
	case mode == "remux":
		pattern = "komika-tx-*.mp4"
	}
	outFile, err := os.CreateTemp("", pattern)
	if err != nil {
		return nil, fmt.Errorf("%w: create output: %v", errTranscodeFailed, err)
	}
	outPath := outFile.Name()
	_ = outFile.Close()
	_ = os.Remove(outPath)

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-i", inputPath,
	}
	args = append(args, argsTail...)
	args = append(args, outPath)

	if err := runFFmpegCommand(ctx, ffmpegPath, args); err != nil {
		_ = os.Remove(outPath)
		return nil, err
	}

	info, err := os.Stat(outPath)
	if err != nil {
		_ = os.Remove(outPath)
		return nil, fmt.Errorf("%w: stat output: %v", errTranscodeFailed, err)
	}
	size := info.Size()
	if size <= 0 {
		_ = os.Remove(outPath)
		return nil, fmt.Errorf("%w: empty output", errTranscodeFailed)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil || s.active.generation != generation {
		_ = os.Remove(outPath)
		return nil, errNoActiveComic
	}
	if !s.reserveTranscodeTempLocked(size) {
		_ = os.Remove(outPath)
		return nil, errTranscodeCacheFull
	}
	entry := &transcodeCacheEntry{
		key:        cacheKey,
		generation: generation,
		path:       outPath,
		mime:       outMime,
		ownedBytes: size,
		modTime:    info.ModTime(),
	}
	// Insert under the same lock as reserve so retire/invalidate cannot miss the file.
	s.transcodeCache[cacheKey] = entry
	return entry, nil
}
func transcodeOutputArgs(kind string, mode string) (mime string, args []string) {
	if kind == "audio" {
		return "audio/ogg", []string{
			"-threads", "2",
			"-vn",
			"-c:a", "libopus",
			"-b:a", "96k",
			"-f", "ogg",
		}
	}
	if mode == "remux" {
		// Lossless: video + optional audio only; drop data/timecode tracks.
		return "video/mp4", []string{
			"-map", "0:v:0",
			"-map", "0:a:0?",
			"-c", "copy",
			"-dn",
			"-map_metadata", "-1",
			"-movflags", "+faststart",
			"-f", "mp4",
		}
	}
	// Cap threads so interactive UI stays responsive during 1080p/4K re-encode.
	// Optional audio map: many camera clips are video-only (+ tmcd data).
	// Longer side ≤1280: WebKitGTK often dies ~1s into H.264 Level 5.2 4K.
	return "video/webm", []string{
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",
		"-threads", "2",
		"-c:v", "libvpx",
		"-b:v", "1M",
		"-crf", "35",
		"-deadline", "realtime",
		"-cpu-used", "8",
		"-row-mt", "1",
		"-auto-alt-ref", "0",
		"-c:a", "libopus",
		"-b:a", "96k",
		"-f", "webm",
	}
}

func (s *ComicService) materializeTranscodeInput(ps pageStream) (path string, cleanup func(), err error) {
	if ps.path != "" {
		if _, statErr := os.Stat(ps.path); statErr != nil {
			return "", nil, fmt.Errorf("%w: source missing: %v", errTranscodeFailed, statErr)
		}
		return ps.path, nil, nil
	}
	if ps.open == nil {
		return "", nil, fmt.Errorf("%w: no source reader", errTranscodeFailed)
	}
	rc, openErr := ps.open()
	if openErr != nil {
		return "", nil, fmt.Errorf("%w: open source: %v", errTranscodeFailed, openErr)
	}
	defer rc.Close()

	tmp, createErr := os.CreateTemp("", "komika-tx-src-*")
	if createErr != nil {
		return "", nil, fmt.Errorf("%w: create input temp: %v", errTranscodeFailed, createErr)
	}
	tmpPath := tmp.Name()
	cleanup = func() { _ = os.Remove(tmpPath) }

	written, copyErr := io.Copy(tmp, rc)
	closeErr := tmp.Close()
	if copyErr != nil {
		cleanup()
		return "", nil, fmt.Errorf("%w: copy source: %v", errTranscodeFailed, copyErr)
	}
	if closeErr != nil {
		cleanup()
		return "", nil, fmt.Errorf("%w: close input temp: %v", errTranscodeFailed, closeErr)
	}
	if written == 0 {
		cleanup()
		return "", nil, fmt.Errorf("%w: empty source", errTranscodeFailed)
	}
	return tmpPath, cleanup, nil
}

func (s *ComicService) transcodeCacheKey(generation uint64, index int, mime string, ps pageStream, mode string) (string, error) {
	var size int64
	var modUnix int64
	var pathPart string
	if ps.path != "" {
		pathPart = ps.path
		if info, err := os.Stat(ps.path); err == nil {
			size = info.Size()
			modUnix = info.ModTime().UnixNano()
		} else {
			size = ps.sizeBytes
			if !ps.modTime.IsZero() {
				modUnix = ps.modTime.UnixNano()
			}
		}
	} else {
		pathPart = fmt.Sprintf("page:%d", index)
		size = ps.sizeBytes
		if !ps.modTime.IsZero() {
			modUnix = ps.modTime.UnixNano()
		}
	}
	profile := transcodeProfileWebM
	if mediaKindFromMime(mime) == "audio" {
		profile = transcodeAudioProfile
	} else if mode == "remux" {
		profile = transcodeProfileRemuxMP4
	}
	return fmt.Sprintf("%d|%d|%s|%s|%d|%d|%s", generation, index, mime, pathPart, size, modUnix, profile), nil
}

func (s *ComicService) reserveTranscodeTempLocked(size int64) bool {
	if size < 0 {
		return false
	}
	// Never evict while a generation is active: stream tokens may still be
	// serving the cached file (Range seeks). Exceeding the budget fails closed.
	if s.transcodeTempBytes+size > s.maxTranscodeTempBytes {
		return false
	}
	s.transcodeTempBytes += size
	return true
}

func (s *ComicService) removeTranscodeEntryLocked(key string) {
	entry := s.transcodeCache[key]
	if entry == nil {
		return
	}
	delete(s.transcodeCache, key)
	if entry.path != "" {
		_ = os.Remove(entry.path)
	}
	s.transcodeTempBytes -= entry.ownedBytes
	if s.transcodeTempBytes < 0 {
		s.transcodeTempBytes = 0
	}
}

func (s *ComicService) invalidateTranscodeCacheLocked() {
	for key := range s.transcodeCache {
		s.removeTranscodeEntryLocked(key)
	}
	// Kill in-flight ffmpeg for the retiring generation so leases can drop.
	for _, flight := range s.transcodeInflight {
		if flight == nil || flight.cancel == nil {
			continue
		}
		flight.cancel()
		flight.cancel = nil
	}
}

func mediaKindFromMime(mime string) string {
	lower := strings.ToLower(strings.TrimSpace(mime))
	switch {
	case strings.HasPrefix(lower, "image/"):
		return "image"
	case lower == "video/webm" || lower == "video/mp4" || lower == "video/quicktime":
		return "video"
	case lower == "audio/mpeg" || lower == "audio/mp4" || lower == "audio/aac" ||
		lower == "audio/ogg" || lower == "audio/opus" || lower == "audio/wav":
		return "audio"
	case lower == "application/pdf":
		return "pdf"
	case lower == "text/markdown" || lower == "text/x-markdown":
		return "markdown"
	default:
		return ""
	}
}
