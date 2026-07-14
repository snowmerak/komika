package main

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReaderFixtureArchiveAndFolder(t *testing.T) {
	folder := filepath.Join("testdata", "reader-fixture")
	cbz := filepath.Join("testdata", "reader-fixture.cbz")

	for _, tc := range []struct {
		name string
		path string
		typ  string
	}{
		{"folder", folder, sourceTypeFolder},
		{"archive", cbz, sourceTypeArchive},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src, err := openPageSource(tc.path)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			if src.SourceType() != tc.typ {
				t.Fatalf("type %q", src.SourceType())
			}
			if src.PageCount() != 5 {
				t.Fatalf("count %d names=%v", src.PageCount(), pageNames(src))
			}
			names := pageNames(src)
			want := []string{"1.png", "2.png", "3-small.png", "4-tall.png", "10.png"}
			for i, w := range want {
				if strings.ToLower(filepath.Base(names[i])) != w {
					t.Fatalf("order[%d]=%q want %q all=%v", i, names[i], w, names)
				}
			}
			for i := range 5 {
				mime, data, err := src.ReadPage(i)
				if err != nil {
					t.Fatal(err)
				}
				if mime != "image/png" {
					t.Fatalf("mime %q", mime)
				}
				payload := encodePagePayload(i, mime, data)
				if payload.Mime != "image/png" || !bytes.Equal(payload.Data, data) {
					t.Fatalf("payload mime=%q len=%d", payload.Mime, len(payload.Data))
				}
				cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				base := strings.ToLower(filepath.Base(names[i]))
				switch base {
				case "3-small.png":
					if cfg.Width != 32 || cfg.Height != 32 {
						t.Fatalf("%s dims %dx%d", base, cfg.Width, cfg.Height)
					}
				case "4-tall.png":
					if cfg.Width != 400 || cfg.Height != 1200 {
						t.Fatalf("%s dims %dx%d", base, cfg.Width, cfg.Height)
					}
				}
			}
		})
	}
}

func TestMediaFixtureSources(t *testing.T) {
	wantBases := []string{
		"1.png",
		"2.png",
		"3-small.png",
		"4-tall.png",
		"6-loop.gif",
		"7-video.webm",
		"8-video.mp4",
		"9-video.mov",
		"10.png",
	}
	wantMimes := []string{
		"image/png",
		"image/png",
		"image/png",
		"image/png",
		"image/gif",
		"video/webm",
		"video/mp4",
		"video/quicktime",
		"image/png",
	}

	for _, tc := range []struct {
		name      string
		path      string
		pageCount int
		bases     []string
		mimes     []string
	}{
		{
			name:      "folder",
			path:      filepath.Join("testdata", "media-fixture"),
			pageCount: 9,
			bases:     wantBases,
			mimes:     wantMimes,
		},
		{
			name:      "cbz",
			path:      filepath.Join("testdata", "media-fixture.cbz"),
			pageCount: 9,
			bases:     wantBases,
			mimes:     wantMimes,
		},
		{
			name:      "7z",
			path:      filepath.Join("testdata", "media-fixture.7z"),
			pageCount: 9,
			bases:     wantBases,
			mimes:     wantMimes,
		},
		{
			name:      "cbr",
			path:      filepath.Join("testdata", "media-fixture.cbr"),
			pageCount: 3,
			bases:     []string{"1.png", "6-loop.gif", "7-video.webm"},
			mimes:     []string{"image/png", "image/gif", "video/webm"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src, err := openPageSource(tc.path)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			if src.PageCount() != tc.pageCount {
				t.Fatalf("count %d names=%v", src.PageCount(), pageNames(src))
			}
			names := pageNames(src)
			for i, wantBase := range tc.bases {
				got := strings.ToLower(filepath.Base(names[i]))
				if got != wantBase {
					t.Fatalf("order[%d]=%q want %q all=%v", i, names[i], wantBase, names)
				}
				desc := src.PageDescriptor(i)
				if desc.Mime != tc.mimes[i] {
					t.Fatalf("descriptor mime[%d]=%q want %q", i, desc.Mime, tc.mimes[i])
				}
				mime, data, err := src.ReadPage(i)
				if err != nil {
					t.Fatal(err)
				}
				if mime != tc.mimes[i] {
					t.Fatalf("read mime[%d]=%q want %q", i, mime, tc.mimes[i])
				}
				if len(data) == 0 {
					t.Fatalf("empty data for %s", names[i])
				}
			}
		})
	}
}

func TestMediaFixtureArchiveAliases(t *testing.T) {
	// Plan requires CB7/7z and CBR/RAR open paths; reuse committed fixtures under alias extensions.
	for _, tc := range []struct {
		name   string
		src    string
		suffix string
		count  int
	}{
		{"cb7", filepath.Join("testdata", "media-fixture.7z"), ".cb7", 9},
		{"rar", filepath.Join("testdata", "media-fixture.cbr"), ".rar", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, err := os.ReadFile(tc.src)
			if err != nil {
				t.Fatal(err)
			}
			dst := filepath.Join(t.TempDir(), "alias"+tc.suffix)
			if err := os.WriteFile(dst, data, 0o600); err != nil {
				t.Fatal(err)
			}
			src, err := openPageSource(dst)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			if src.PageCount() != tc.count {
				t.Fatalf("count %d names=%v", src.PageCount(), pageNames(src))
			}
			if src.SourceType() != sourceTypeArchive {
				t.Fatalf("type %q", src.SourceType())
			}
		})
	}
}
