package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestZipArchiveReusesDirectIndex(t *testing.T) {
	src, err := openPageSource(filepath.Join("testdata", "reader-fixture.cbz"))
	if err != nil {
		t.Fatal(err)
	}
	archive, ok := src.(*archiveSource)
	if !ok {
		t.Fatalf("source type %T", src)
	}
	defer archive.Close()

	if len(archive.directOpen) != archive.PageCount() {
		t.Fatalf("direct openers=%d pages=%d", len(archive.directOpen), archive.PageCount())
	}
	// Prove page reads no longer depend on ArchiveFS.Open rebuilding an index.
	archive.fsys = nil
	mime, data, err := archive.ReadPage(archive.PageCount() - 1)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/png" || len(data) == 0 {
		t.Fatalf("mime=%q bytes=%d", mime, len(data))
	}
}

func TestSequentialArchivesPopulateAndCleanReadCache(t *testing.T) {
	for _, archivePath := range []string{
		filepath.Join("testdata", "media-fixture.7z"),
		filepath.Join("testdata", "media-fixture.cbr"),
	} {
		t.Run(filepath.Ext(archivePath), func(t *testing.T) {
			src, err := openPageSource(archivePath)
			if err != nil {
				t.Fatal(err)
			}
			archive, ok := src.(*archiveSource)
			if !ok {
				t.Fatalf("source type %T", src)
			}
			if archive.readCache == nil {
				_ = archive.Close()
				t.Fatal("sequential archive read cache was not started")
			}
			cacheDir := archive.readCache.dir

			cachedPath, err := archive.readCache.waitPath(archive.names[0])
			if err != nil {
				_ = archive.Close()
				t.Fatal(err)
			}
			if cachedPath == "" {
				_ = archive.Close()
				t.Fatal("first image was not cached")
			}
			if _, err := os.Stat(cachedPath); err != nil {
				_ = archive.Close()
				t.Fatalf("cached page: %v", err)
			}

			// Cached RPC pages remain readable without another ArchiveFS traversal.
			archive.fsys = nil
			mime, data, err := archive.ReadPage(0)
			if err != nil {
				_ = archive.Close()
				t.Fatal(err)
			}
			if mime == "" || len(data) == 0 {
				_ = archive.Close()
				t.Fatalf("mime=%q bytes=%d", mime, len(data))
			}

			if err := archive.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(cacheDir); !os.IsNotExist(err) {
				t.Fatalf("cache directory still exists: %v", err)
			}
		})
	}
}
