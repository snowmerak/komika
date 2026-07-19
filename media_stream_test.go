package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testService(t *testing.T) *ComicService {
	t.Helper()
	dir := t.TempDir()
	store, err := NewLibraryStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	return NewComicServiceWithStore(store)
}

func writeOversizedFolder(t *testing.T) (folder string, size int) {
	t.Helper()
	dir := t.TempDir()
	payload := make([]byte, maxPageBytes+1)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	path := filepath.Join(dir, "huge.mp4")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, len(payload)
}

func writeOversizedArchive(t *testing.T, name string, n int) string {
	t.Helper()
	zipPath := filepath.Join(t.TempDir(), name)
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("huge.mp4")
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, n)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return zipPath
}

func serveMediaRequest(svc *ComicService, method, urlPath string, headers map[string]string) *httptest.ResponseRecorder {
	handler := mediaMiddleware(svc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(method, urlPath, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

func TestFolderStreamRangeResponse(t *testing.T) {
	svc := testService(t)
	folder, total := writeOversizedFolder(t)
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Pages[0].Delivery != deliveryStream {
		t.Fatalf("delivery=%q", comic.Pages[0].Delivery)
	}

	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if ps == nil || ps.Token == "" || !strings.HasSuffix(ps.URL, mediaPathPrefix+ps.Token) {
		t.Fatalf("unexpected PageStream: %+v", ps)
	}
	if !strings.HasPrefix(ps.URL, "http://127.0.0.1:") {
		t.Fatalf("want loopback http URL, got %q", ps.URL)
	}

	rr := serveMediaRequest(svc, http.MethodGet, ps.URL, map[string]string{
		"Range": "bytes=8-15",
	})
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges=%q", got)
	}
	wantCR := fmt.Sprintf("bytes 8-15/%d", total)
	if got := rr.Header().Get("Content-Range"); got != wantCR {
		t.Fatalf("Content-Range=%q want %q", got, wantCR)
	}
	if rr.Body.Len() != 8 {
		t.Fatalf("body len=%d", rr.Body.Len())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Fatalf("Content-Type=%q", ct)
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control=%q", cc)
	}

	rr = serveMediaRequest(svc, http.MethodHead, ps.URL, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("HEAD status=%d", rr.Code)
	}

	rr = serveMediaRequest(svc, http.MethodPost, ps.URL, nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", rr.Code)
	}

	rr = serveMediaRequest(svc, http.MethodGet, "/media/", nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("empty token status=%d", rr.Code)
	}
	rr = serveMediaRequest(svc, http.MethodGet, "/media/not-a-real-token", nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("unknown token status=%d", rr.Code)
	}
	rr = serveMediaRequest(svc, http.MethodGet, "/media/a/b", nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("multi-segment status=%d", rr.Code)
	}

	rr = serveMediaRequest(svc, http.MethodGet, "/index.html", nil)
	if rr.Code != http.StatusTeapot {
		t.Fatalf("passthrough status=%d", rr.Code)
	}

	if err := svc.ReleasePageStream(ps.Token); err != nil {
		t.Fatal(err)
	}
	rr = serveMediaRequest(svc, http.MethodGet, ps.URL, nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("after release status=%d", rr.Code)
	}
}

func TestArchiveStreamMaterializeAndRange(t *testing.T) {
	svc := testService(t)
	n := maxPageBytes + 64
	zipPath := writeOversizedArchive(t, "huge.cbz", n)
	comic, err := svc.openPath(zipPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Pages[0].Delivery != deliveryStream {
		t.Fatalf("delivery=%q", comic.Pages[0].Delivery)
	}

	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}

	svc.mu.Lock()
	entry := svc.streams[ps.Token]
	tmpPath := ""
	if entry != nil {
		tmpPath = entry.path
		if !entry.temporary {
			svc.mu.Unlock()
			t.Fatal("expected temporary archive stream")
		}
	}
	svc.mu.Unlock()
	if tmpPath == "" {
		t.Fatal("missing temp path")
	}
	if _, err := os.Stat(tmpPath); err != nil {
		t.Fatalf("temp missing: %v", err)
	}

	rr := serveMediaRequest(svc, http.MethodGet, ps.URL, map[string]string{
		"Range": "bytes=8-15",
	})
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("status=%d", rr.Code)
	}
	if rr.Body.Len() != 8 {
		t.Fatalf("body len=%d", rr.Body.Len())
	}
	wantCR := fmt.Sprintf("bytes 8-15/%d", n)
	if got := rr.Header().Get("Content-Range"); got != wantCR {
		t.Fatalf("Content-Range=%q want %q", got, wantCR)
	}
	if got := rr.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges=%q", got)
	}

	if err := svc.ReleasePageStream(ps.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("temp should be removed, err=%v", err)
	}
	svc.mu.Lock()
	if svc.archiveTempBytes != 0 {
		t.Fatalf("archiveTempBytes=%d after release", svc.archiveTempBytes)
	}
	svc.mu.Unlock()
}

func TestArchiveStreamLimits(t *testing.T) {
	// Per-entry overflow is enforced on bytes copied, not metadata.
	// maxArchiveStreamBytes is between copyChunkSize and the entry size so
	// materialization starts writing then fails and cleans partial output.
	svc := testService(t)
	svc.maxArchiveStreamBytes = copyChunkSize + 64
	svc.maxArchiveTempBytes = 1 << 30
	zipPath := writeOversizedArchive(t, "over.cbz", maxPageBytes+1)
	if _, err := svc.openPath(zipPath, false); err != nil {
		t.Fatal(err)
	}
	beforeTemps, _ := filepath.Glob(filepath.Join(os.TempDir(), "komika-media-*"))
	_, err := svc.GetPageStream(0)
	if !errors.Is(err, errArchiveStreamTooLarge) {
		t.Fatalf("want per-entry limit, got %v", err)
	}
	afterTemps, _ := filepath.Glob(filepath.Join(os.TempDir(), "komika-media-*"))
	if len(afterTemps) > len(beforeTemps) {
		t.Fatalf("partial temp not cleaned: before=%d after=%d extra=%v",
			len(beforeTemps), len(afterTemps), afterTemps)
	}
	svc.mu.Lock()
	if svc.archiveTempBytes != 0 || svc.archiveTempPendingBytes != 0 || len(svc.streams) != 0 {
		t.Fatalf("leaked state: temp=%d pending=%d streams=%d",
			svc.archiveTempBytes, svc.archiveTempPendingBytes, len(svc.streams))
	}
	svc.mu.Unlock()

	// Aggregate: first stream occupies the budget; second rejected until release.
	svc4 := testService(t)
	entrySize := maxPageBytes + 50
	svc4.maxArchiveStreamBytes = int64(entrySize + 10)
	svc4.maxArchiveTempBytes = int64(entrySize + 10) // only one fits

	zipPath = filepath.Join(t.TempDir(), "agg.cbz")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, name := range []string{"a.mp4", "b.mp4"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(bytes.Repeat([]byte{7}, entrySize)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := svc4.openPath(zipPath, false); err != nil {
		t.Fatal(err)
	}
	first, err := svc4.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc4.GetPageStream(1)
	if !errors.Is(err, errArchiveTempCacheFull) {
		t.Fatalf("want aggregate full, got %v", err)
	}
	if err := svc4.ReleasePageStream(first.Token); err != nil {
		t.Fatal(err)
	}
	second, err := svc4.GetPageStream(1)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	_ = svc4.ReleasePageStream(second.Token)
}

// blockingSource holds StreamPage.open until released.
type blockingSource struct {
	inner   pageSource
	blockCh chan struct{}
	entered chan struct{}
	closed  atomic.Bool
	closeCh chan struct{}
}

func (b *blockingSource) Title() string      { return b.inner.Title() }
func (b *blockingSource) SourceType() string { return b.inner.SourceType() }
func (b *blockingSource) Path() string       { return b.inner.Path() }
func (b *blockingSource) PageCount() int     { return b.inner.PageCount() }
func (b *blockingSource) PageDescriptor(index int) PageDescriptor {
	return b.inner.PageDescriptor(index)
}
func (b *blockingSource) ReadPage(index int) (string, []byte, error) {
	return b.inner.ReadPage(index)
}
func (b *blockingSource) StreamPage(index int) (pageStream, error) {
	ps, err := b.inner.StreamPage(index)
	if err != nil {
		return ps, err
	}
	orig := ps.open
	ps.open = func() (io.ReadCloser, error) {
		select {
		case b.entered <- struct{}{}:
		default:
		}
		<-b.blockCh
		return orig()
	}
	// Force archive-style materialization path by clearing direct path.
	ps.path = ""
	return ps, nil
}
func (b *blockingSource) Close() error {
	b.closed.Store(true)
	close(b.closeCh)
	return b.inner.Close()
}

func TestGetPageStreamLeaseAcrossOpenPath(t *testing.T) {
	svc := testService(t)
	folder, _ := writeOversizedFolder(t)
	src, err := openPageSource(folder)
	if err != nil {
		t.Fatal(err)
	}
	block := make(chan struct{})
	entered := make(chan struct{}, 1)
	closeCh := make(chan struct{})
	bs := &blockingSource{inner: src, blockCh: block, entered: entered, closeCh: closeCh}

	svc.mu.Lock()
	svc.retireActiveLocked()
	svc.promoteSourceLocked(bs)
	svc.mu.Unlock()

	var (
		wg     sync.WaitGroup
		stream *PageStream
		getErr error
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		stream, getErr = svc.GetPageStream(0)
	}()

	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(block)
		t.Fatal("StreamPage open did not start")
	}

	// Replace comic while lease is held.
	folder2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder2, "ok.png"), tinyPNG(3), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(folder2, false); err != nil {
		t.Fatal(err)
	}

	// Old source must not be closed yet.
	select {
	case <-closeCh:
		t.Fatal("old source closed before lease release")
	case <-time.After(50 * time.Millisecond):
	}

	close(block)
	wg.Wait()

	// Stale materialization must not publish a token.
	if getErr == nil {
		t.Fatalf("expected stale GetPageStream error, got stream=%+v", stream)
	}
	if !errors.Is(getErr, errNoActiveComic) {
		t.Fatalf("want errNoActiveComic, got %v", getErr)
	}

	select {
	case <-closeCh:
	case <-time.After(2 * time.Second):
		t.Fatal("old source not closed after lease release")
	}

	svc.mu.Lock()
	if len(svc.streams) != 0 {
		t.Fatalf("stale streams published: %d", len(svc.streams))
	}
	if svc.archiveTempBytes != 0 || svc.archiveTempPendingBytes != 0 {
		t.Fatalf("temp budget leak: %d / %d", svc.archiveTempBytes, svc.archiveTempPendingBytes)
	}
	svc.mu.Unlock()
}

func TestOpenPathInvalidatesPriorStream(t *testing.T) {
	svc := testService(t)
	folder, _ := writeOversizedFolder(t)
	if _, err := svc.openPath(folder, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}

	folder2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder2, "x.png"), tinyPNG(4), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(folder2, false); err != nil {
		t.Fatal(err)
	}

	rr := serveMediaRequest(svc, http.MethodGet, ps.URL, nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("old URL status=%d", rr.Code)
	}
}

func TestOpenPathRetainsInFlightArchiveTemp(t *testing.T) {
	svc := testService(t)
	n := maxPageBytes + 128
	zipPath := writeOversizedArchive(t, "inflight.cbz", n)
	if _, err := svc.openPath(zipPath, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate an in-flight HTTP handler holding a reference.
	entry, err := svc.acquireStreamEntry(ps.Token)
	if err != nil {
		t.Fatal(err)
	}
	tmpPath := entry.path
	if tmpPath == "" || !entry.temporary {
		t.Fatal("expected owned archive temp")
	}
	if _, err := os.Stat(tmpPath); err != nil {
		t.Fatalf("temp missing before replace: %v", err)
	}
	svc.mu.Lock()
	budgetBefore := svc.archiveTempBytes
	svc.mu.Unlock()
	if budgetBefore <= 0 {
		t.Fatalf("archiveTempBytes=%d", budgetBefore)
	}

	// Replace comic: new requests must 404 immediately, but temp stays until handler release.
	folder2 := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder2, "y.png"), tinyPNG(5), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(folder2, false); err != nil {
		t.Fatal(err)
	}

	rr := serveMediaRequest(svc, http.MethodGet, ps.URL, nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("old URL status=%d after replace", rr.Code)
	}
	if _, err := os.Stat(tmpPath); err != nil {
		t.Fatalf("temp removed while handler held ref: %v", err)
	}
	svc.mu.Lock()
	if svc.archiveTempBytes != budgetBefore {
		t.Fatalf("budget changed while in-flight: got %d want %d", svc.archiveTempBytes, budgetBefore)
	}
	svc.mu.Unlock()

	svc.releaseStreamEntry(entry)

	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("temp should be removed after final release, err=%v", err)
	}
	svc.mu.Lock()
	if svc.archiveTempBytes != 0 {
		t.Fatalf("archiveTempBytes=%d after final release", svc.archiveTempBytes)
	}
	svc.mu.Unlock()
}

func TestGetPageStreamRejectsRPCPage(t *testing.T) {
	svc := testService(t)
	folder := makeFolderFixture(t)
	comic, err := svc.openPath(folder, false)
	if err != nil {
		t.Fatal(err)
	}
	idx := -1
	for i, p := range comic.Pages {
		// Images stay RPC when small; A/V is always stream now.
		if p.Delivery == deliveryRPC && strings.HasPrefix(p.Mime, "image/") {
			idx = i
			break
		}
	}
	if idx < 0 {
		t.Fatal("no rpc image page")
	}
	_, err = svc.GetPageStream(idx)
	if !errors.Is(err, errNotStreamPage) {
		t.Fatalf("want errNotStreamPage, got %v", err)
	}
}


func TestServiceShutdownCleansStreams(t *testing.T) {
	svc := testService(t)
	folder, _ := writeOversizedFolder(t)
	if _, err := svc.openPath(folder, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	rr := serveMediaRequest(svc, http.MethodGet, ps.URL, nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rr.Code)
	}
	svc.mu.Lock()
	if svc.active != nil {
		t.Fatal("active still set")
	}
	svc.mu.Unlock()
}

func TestSmallVideoAlwaysStreamsWithRange(t *testing.T) {
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
	comic, err := svc.openPath(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Pages[0].Delivery != deliveryStream {
		t.Fatalf("small video delivery=%q want stream", comic.Pages[0].Delivery)
	}
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := fetchMediaURL(http.MethodGet, ps.URL, map[string]string{"Range": "bytes=0-15"})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Range"); !strings.HasPrefix(got, "bytes 0-15/") {
		t.Fatalf("Content-Range=%q", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "video/mp4" {
		t.Fatalf("Content-Type=%q", ct)
	}
	body := make([]byte, 32)
	n, _ := resp.Body.Read(body)
	if n != 16 {
		t.Fatalf("body len=%d", n)
	}
}


func TestVideoAlwaysStreamsEvenWhenUnderRPCLimit(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	// Pad with trailing zeros past half of maxPageBytes while staying under the limit.
	// Delivery must still be stream because mime is video/*, not because of size.
	if int64(len(data)) >= maxPageBytes/2 {
		t.Fatalf("fixture unexpectedly large: %d", len(data))
	}
	padTo := int(maxPageBytes / 2)
	padded := make([]byte, padTo)
	copy(padded, data)
	path := filepath.Join(dir, "padded.mp4")
	if err := os.WriteFile(path, padded, 0o600); err != nil {
		t.Fatal(err)
	}
	comic, err := svc.openPath(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Pages[0].Delivery != deliveryStream {
		t.Fatalf("delivery=%q want stream for video under RPC size limit", comic.Pages[0].Delivery)
	}
	// Ensure GetPageStream works and Range is correct against padded size.
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := fetchMediaURL(http.MethodGet, ps.URL, map[string]string{"Range": "bytes=0-15"})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	want := fmt.Sprintf("bytes 0-15/%d", padTo)
	if got := resp.Header.Get("Content-Range"); got != want {
		t.Fatalf("Content-Range=%q want %q", got, want)
	}
	mid := padTo / 2
	resp2, err := fetchMediaURL(http.MethodGet, ps.URL, map[string]string{
		"Range": fmt.Sprintf("bytes=%d-%d", mid, mid+63),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	body := make([]byte, 128)
	n, _ := resp2.Body.Read(body)
	if resp2.StatusCode != http.StatusPartialContent || n != 64 {
		t.Fatalf("mid status=%d len=%d", resp2.StatusCode, n)
	}
}

func TestForcesStreamDeliveryPrefixes(t *testing.T) {
	cases := []struct {
		mime string
		want bool
	}{
		{"video/mp4", true},
		{"VIDEO/WEBM", true},
		{"video/x-matroska", true},
		{"audio/flac", true},
		{"audio/mpeg", true},
		{"image/png", false},
		{"application/pdf", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := forcesStreamDelivery(tc.mime); got != tc.want {
			t.Fatalf("forcesStreamDelivery(%q)=%v want %v", tc.mime, got, tc.want)
		}
	}
}

func fetchMediaURL(method, rawURL string, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequest(method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return http.DefaultClient.Do(req)
}
