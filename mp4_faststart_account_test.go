package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFaststartTempAccountingBalanced(t *testing.T) {
	src := "/media/veracrypt1/video/7c27eeeacdf685a5b5ea445e9d65b10c1bb963739a744b5a6de2cd2b08d9e505.mp4"
	if _, err := os.Stat(src); err != nil {
		t.Skip(err)
	}
	svc := testService(t)
	if _, err := svc.openPath(src, false); err != nil {
		t.Fatal(err)
	}
	before := svc.archiveTempBytes
	ps, err := svc.GetPageStream(0)
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	mid := svc.archiveTempBytes
	entry := svc.streams[ps.Token]
	if entry == nil || !entry.temporary {
		svc.mu.Unlock()
		t.Fatalf("expected temporary faststart entry: %+v", entry)
	}
	owned := entry.ownedBytes
	path := entry.path
	svc.mu.Unlock()
	if mid != before+owned {
		t.Fatalf("archiveTempBytes mid=%d want before(%d)+owned(%d)", mid, before, owned)
	}
	if base := filepath.Base(filepath.Dir(path)); base != "" && filepath.Base(filepath.Dir(path))[:16] != "komika-faststart" {
		// prefix check
		if len(filepath.Base(filepath.Dir(path))) < 16 || filepath.Base(filepath.Dir(path))[:16] != "komika-faststart" {
			t.Fatalf("path not under faststart dir: %s", path)
		}
	}
	if err := svc.ReleasePageStream(ps.Token); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	after := svc.archiveTempBytes
	svc.mu.Unlock()
	if after != before {
		t.Fatalf("archiveTempBytes after release=%d want %d", after, before)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("temp path should be gone: %v", err)
	}
}
