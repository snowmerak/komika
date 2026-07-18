package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetTranscodedStreamRequiresAV(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "1.png"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}
	_, err := svc.GetTranscodedStream(0)
	if !errors.Is(err, errTranscodeUnsupported) {
		t.Fatalf("err=%v want %v", err, errTranscodeUnsupported)
	}
}

func TestGetTranscodedStreamMissingFFmpeg(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}

	oldLook := lookFFmpegPath
	lookFFmpegPath = func() (string, error) { return "", errors.New("missing") }
	defer func() { lookFFmpegPath = oldLook }()

	_, err = svc.GetTranscodedStream(0)
	if !errors.Is(err, errFFmpegUnavailable) {
		t.Fatalf("err=%v want %v", err, errFFmpegUnavailable)
	}
}

func TestGetTranscodedStreamCachesAndSingleflight(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}

	var runs atomic.Int32
	oldLook := lookFFmpegPath
	oldRun := runFFmpegCommand
	lookFFmpegPath = func() (string, error) { return "ffmpeg", nil }
	runFFmpegCommand = func(ctx context.Context, _ string, args []string) error {
		runs.Add(1)
		out := args[len(args)-1]
		time.Sleep(30 * time.Millisecond)
		if err := ctx.Err(); err != nil {
			return errTranscodeCanceled
		}
		return os.WriteFile(out, []byte("webm-bytes"), 0o600)
	}
	defer func() {
		lookFFmpegPath = oldLook
		runFFmpegCommand = oldRun
	}()

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	streams := make([]*PageStream, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			ps, err := svc.GetTranscodedStream(0)
			errs[i] = err
			streams[i] = ps
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
		if streams[i] == nil || streams[i].Token == "" || streams[i].URL == "" {
			t.Fatalf("caller %d empty stream: %+v", i, streams[i])
		}
		if streams[i].Mime != "video/webm" {
			t.Fatalf("caller %d mime=%q", i, streams[i].Mime)
		}
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("ffmpeg runs=%d want 1", got)
	}

	ps, err := svc.GetTranscodedStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if ps.Mime != "video/webm" {
		t.Fatalf("mime=%q", ps.Mime)
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("after cache ffmpeg runs=%d want 1", got)
	}

	rr := serveMediaRequest(svc, "GET", ps.URL, nil)
	if rr.Code != 200 {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "video/webm" {
		t.Fatalf("Content-Type=%q", ct)
	}
	if rr.Body.String() != "webm-bytes" {
		t.Fatalf("body=%q", rr.Body.String())
	}
}

func TestGetTranscodedStreamRealFFmpeg(t *testing.T) {
	if _, err := lookFFmpegPath(); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	svc := testService(t)
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetTranscodedStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if ps.Mime != "video/webm" {
		t.Fatalf("mime=%q", ps.Mime)
	}
	rr := serveMediaRequest(svc, "GET", ps.URL, nil)
	if rr.Code != 200 {
		t.Fatalf("status=%d", rr.Code)
	}
	if rr.Body.Len() < 100 {
		t.Fatalf("body too small: %d", rr.Body.Len())
	}
	svc.mu.Lock()
	svc.retireActiveLocked()
	svc.mu.Unlock()
	if len(svc.transcodeCache) != 0 {
		t.Fatalf("cache not cleared: %d", len(svc.transcodeCache))
	}
}

func TestTranscodeCacheFull(t *testing.T) {
	svc := testService(t)
	svc.maxTranscodeTempBytes = 8
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}

	oldLook := lookFFmpegPath
	oldRun := runFFmpegCommand
	lookFFmpegPath = func() (string, error) { return "ffmpeg", nil }
	runFFmpegCommand = func(ctx context.Context, _ string, args []string) error {
		out := args[len(args)-1]
		return os.WriteFile(out, []byte("0123456789"), 0o600)
	}
	defer func() {
		lookFFmpegPath = oldLook
		runFFmpegCommand = oldRun
	}()

	_, err = svc.GetTranscodedStream(0)
	if !errors.Is(err, errTranscodeCacheFull) {
		t.Fatalf("err=%v want %v", err, errTranscodeCacheFull)
	}
}

func TestTranscodeCanceledOnRetire(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(dir, false); err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	oldLook := lookFFmpegPath
	oldRun := runFFmpegCommand
	lookFFmpegPath = func() (string, error) { return "ffmpeg", nil }
	runFFmpegCommand = func(ctx context.Context, _ string, args []string) error {
		close(started)
		<-ctx.Done()
		return errTranscodeCanceled
	}
	defer func() {
		lookFFmpegPath = oldLook
		runFFmpegCommand = oldRun
	}()

	errCh := make(chan error, 1)
	go func() {
		_, err := svc.GetTranscodedStream(0)
		errCh <- err
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("ffmpeg did not start")
	}

	svc.mu.Lock()
	svc.retireActiveLocked()
	svc.mu.Unlock()

	select {
	case err := <-errCh:
		if !errors.Is(err, errTranscodeCanceled) && !errors.Is(err, errNoActiveComic) {
			t.Fatalf("err=%v want canceled or no active", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("transcode did not finish after cancel")
	}
}
