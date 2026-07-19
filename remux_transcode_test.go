package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetRemuxedStreamUser1080p(t *testing.T) {
	src := "/home/ideapad-debian/다운로드/13850269_1080_1920_60fps.mp4"
	if _, err := os.Stat(src); err != nil {
		t.Skip(err)
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "clip.mp4")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o600); err != nil {
		t.Fatal(err)
	}
	svc := testService(t)
	if _, err := svc.openPath(dst, false); err != nil {
		t.Fatal(err)
	}
	ps, err := svc.GetRemuxedStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if ps.Mime != "video/mp4" {
		t.Fatalf("mime %q", ps.Mime)
	}
	rr := serveMediaRequest(svc, "GET", ps.URL, nil)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	if rr.Body.Len() < 1000 {
		t.Fatalf("body %d", rr.Body.Len())
	}
	// Second call hits cache
	ps2, err := svc.GetRemuxedStream(0)
	if err != nil {
		t.Fatal(err)
	}
	if ps2.Mime != "video/mp4" {
		t.Fatalf("mime2 %q", ps2.Mime)
	}
	t.Logf("remux bytes=%d", rr.Body.Len())
}

func TestGetRemuxedStreamRejectsAudio(t *testing.T) {
	svc := testService(t)
	dir := t.TempDir()
	// tiny fake won't matter — open needs supported ext
	path := filepath.Join(dir, "a.mp3")
	if err := os.WriteFile(path, []byte("ID3"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(path, false); err != nil {
		t.Fatal(err)
	}
	_, err := svc.GetRemuxedStream(0)
	if err == nil {
		t.Fatal("expected error for audio remux")
	}
}
