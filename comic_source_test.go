package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePNG(t *testing.T, path string, color byte) {
	t.Helper()
	// Minimal valid 1x1 PNG (black) with color byte variation in IHDR is hard;
	// use a tiny fixed PNG and different filenames for ordering tests.
	// 1x1 red PNG.
	png := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xd7, 0x63, 0xf8, color, 0x00, 0x00,
		0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
		0x82,
	}
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
}

func tinyPNG(color byte) []byte {
	return []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xd7, 0x63, 0xf8, color, 0x00, 0x00,
		0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
		0x82,
	}
}

func makeFolderFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	// Nested + mixed case + unsupported + natural order names.
	sub := filepath.Join(dir, "ch1")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	writePNG(t, filepath.Join(dir, "10.png"), 0x10)
	writePNG(t, filepath.Join(dir, "2.PNG"), 0x20)
	writePNG(t, filepath.Join(dir, "1.jpg"), 0x30)
	writePNG(t, filepath.Join(sub, "3.WebP"), 0x40)
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("skip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cover.bmp"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func makeZipFixture(t *testing.T, dir string) string {
	t.Helper()
	zipPath := filepath.Join(t.TempDir(), "comic.cbz")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)

	add := func(name string, color byte) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(tinyPNG(color)); err != nil {
			t.Fatal(err)
		}
	}

	// Directory entry should be skipped.
	if _, err := zw.Create("pages/"); err != nil {
		t.Fatal(err)
	}
	add("pages/10.png", 0x10)
	add("pages/2.PNG", 0x20)
	add("pages/1.jpg", 0x30)
	add("readme.txt", 0x00)
	_ = dir

	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return zipPath
}

func TestOpenFolderNaturalOrderAndFilters(t *testing.T) {
	dir := makeFolderFixture(t)
	src, err := openPageSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	if src.SourceType() != sourceTypeFolder {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 4 {
		t.Fatalf("page count: got %d want 4; names=%v", src.PageCount(), pageNames(src))
	}
	names := pageNames(src)
	// Natural order on full relative path: 1.jpg, 2.PNG, 10.png, ch1/3.WebP
	gotBases := make([]string, len(names))
	for i, n := range names {
		gotBases[i] = strings.ToLower(n)
	}
	wantLower := []string{"1.jpg", "2.png", "10.png", "ch1/3.webp"}
	for i := range wantLower {
		if gotBases[i] != wantLower[i] {
			t.Fatalf("order[%d]=%q want %q (all=%v raw=%v)", i, gotBases[i], wantLower[i], gotBases, names)
		}
	}
	mime, data, err := src.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/jpeg" {
		// 1.jpg maps to jpeg even though content is png bytes for fixture simplicity
		t.Fatalf("mime: got %q", mime)
	}
	payload := encodePagePayload(0, mime, data)
	if payload.Mime != "image/jpeg" || len(payload.Data) == 0 || !bytes.Equal(payload.Data, data) {
		t.Fatalf("payload: mime=%q len=%d", payload.Mime, len(payload.Data))
	}
	desc := src.PageDescriptor(0)
	if desc.Mime != "image/jpeg" {
		t.Fatalf("descriptor mime %q", desc.Mime)
	}
}

func TestOpenArchiveNaturalOrderAndFilters(t *testing.T) {
	zipPath := makeZipFixture(t, "")
	src, err := openPageSource(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	if src.SourceType() != sourceTypeArchive {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 3 {
		t.Fatalf("page count: got %d want 3; names=%v", src.PageCount(), pageNames(src))
	}
	names := pageNames(src)
	got := make([]string, len(names))
	for i, n := range names {
		got[i] = strings.ToLower(n)
	}
	want := []string{"pages/1.jpg", "pages/2.png", "pages/10.png"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order[%d]=%q want %q (all=%v)", i, got[i], want[i], got)
		}
	}

	mime, data, err := src.ReadPage(1)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/png" {
		t.Fatalf("mime: got %q", mime)
	}
	payload := encodePagePayload(1, mime, data)
	if payload.Mime != "image/png" || !bytes.Equal(payload.Data, data) {
		t.Fatalf("payload: mime=%q len=%d", payload.Mime, len(payload.Data))
	}
}

func TestNoSupportedPages(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openPageSource(dir)
	if !errors.Is(err, errNoSupportedMedia) {
		t.Fatalf("expected errNoSupportedMedia, got %v", err)
	}
}

func TestInvalidArchive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.zip")
	if err := os.WriteFile(path, []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openPageSource(path)
	if err == nil {
		t.Fatal("expected error for invalid archive")
	}
}

func TestUnsupportedArchiveExtension(t *testing.T) {
	path := filepath.Join(t.TempDir(), "comic.tar")
	if err := os.WriteFile(path, []byte("not an archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openPageSource(path)
	if !errors.Is(err, errUnsupportedSource) {
		t.Fatalf("want unsupported source, got %v", err)
	}
}

func TestOpenStandaloneMedia(t *testing.T) {
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "solo.png")
	writePNG(t, pngPath, 0x11)

	src, err := openPageSource(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeMedia {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 1 {
		t.Fatalf("page count: %d", src.PageCount())
	}
	if src.Title() != "solo.png" {
		t.Fatalf("title: %q", src.Title())
	}
	canon, err := canonicalizePath(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if src.Path() != canon {
		t.Fatalf("path: got %q want %q", src.Path(), canon)
	}
	names := pageNames(src)
	if len(names) != 1 || names[0] != "solo.png" {
		t.Fatalf("names: %v", names)
	}
	desc := src.PageDescriptor(0)
	if desc.Mime != "image/png" {
		t.Fatalf("mime: %q", desc.Mime)
	}
	mime, data, err := src.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/png" || len(data) == 0 {
		t.Fatalf("read: mime=%q len=%d", mime, len(data))
	}
}

func TestOpenStandaloneVideo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clip.webm")
	if err := os.WriteFile(path, []byte("fake-webm-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := openPageSource(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeMedia {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 1 {
		t.Fatalf("page count: %d", src.PageCount())
	}
	if src.PageDescriptor(0).Mime != "video/webm" {
		t.Fatalf("mime: %q", src.PageDescriptor(0).Mime)
	}
	mime, data, err := src.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "video/webm" || string(data) != "fake-webm-bytes" {
		t.Fatalf("read: mime=%q data=%q", mime, data)
	}
}

func TestOpenStandaloneAudio(t *testing.T) {
	tests := []struct {
		ext  string
		mime string
	}{
		{ext: ".mp3", mime: "audio/mpeg"},
		{ext: ".m4a", mime: "audio/mp4"},
		{ext: ".aac", mime: "audio/aac"},
		{ext: ".ogg", mime: "audio/ogg"},
		{ext: ".opus", mime: "audio/opus"},
		{ext: ".wav", mime: "audio/wav"},
	}
	for _, tc := range tests {
		t.Run(tc.ext, func(t *testing.T) {
			wantData := []byte("fake-audio-bytes-" + tc.ext)
			path := filepath.Join(t.TempDir(), "track"+strings.ToUpper(tc.ext))
			if err := os.WriteFile(path, wantData, 0o600); err != nil {
				t.Fatal(err)
			}
			src, err := openPageSource(path)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			if src.SourceType() != sourceTypeMedia {
				t.Fatalf("source type: got %q", src.SourceType())
			}
			if src.PageCount() != 1 {
				t.Fatalf("page count: %d", src.PageCount())
			}
			if src.PageDescriptor(0).Mime != tc.mime {
				t.Fatalf("mime: got %q want %q", src.PageDescriptor(0).Mime, tc.mime)
			}
			mime, data, err := src.ReadPage(0)
			if err != nil {
				t.Fatal(err)
			}
			if mime != tc.mime || !bytes.Equal(data, wantData) {
				t.Fatalf("read: mime=%q data=%q", mime, data)
			}
		})
	}
}

func TestOpenAudioOnlyFolderAndArchive(t *testing.T) {
	t.Run("folder", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "track.MP3"), []byte("folder-audio"), 0o600); err != nil {
			t.Fatal(err)
		}
		src, err := openPageSource(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer src.Close()
		if src.SourceType() != sourceTypeFolder || src.PageCount() != 1 {
			t.Fatalf("source: type=%q pages=%d", src.SourceType(), src.PageCount())
		}
		if got := src.PageDescriptor(0).Mime; got != "audio/mpeg" {
			t.Fatalf("mime: got %q", got)
		}
	})

	t.Run("archive", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "audio.cbz")
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		zw := zip.NewWriter(f)
		w, err := zw.Create("sound/track.opus")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("archive-audio")); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}

		src, err := openPageSource(path)
		if err != nil {
			t.Fatal(err)
		}
		defer src.Close()
		if src.SourceType() != sourceTypeArchive || src.PageCount() != 1 {
			t.Fatalf("source: type=%q pages=%d", src.SourceType(), src.PageCount())
		}
		if got := src.PageDescriptor(0).Mime; got != "audio/opus" {
			t.Fatalf("mime: got %q", got)
		}
	})
}

func TestUnsupportedLooseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openPageSource(path)
	if !errors.Is(err, errUnsupportedSource) {
		t.Fatalf("want errUnsupportedSource, got %v", err)
	}
}

func TestPageOutOfRange(t *testing.T) {
	dir := makeFolderFixture(t)
	src, err := openPageSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	_, _, err = src.ReadPage(-1)
	if err != errPageOutOfRange {
		t.Fatalf("want errPageOutOfRange, got %v", err)
	}
	_, _, err = src.ReadPage(src.PageCount())
	if err != errPageOutOfRange {
		t.Fatalf("want errPageOutOfRange, got %v", err)
	}
}

func TestNaturalCompareOrder(t *testing.T) {
	names := []string{"10.jpg", "2.jpg", "1.jpg", "11.jpg"}
	// sort via naturalLess
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			a, b := names[i], names[j]
			if naturalLess(strings.ToLower(a), strings.ToLower(b), a, b) {
				// ok
			}
		}
	}
	// Explicit expected order
	ordered := []string{"1.jpg", "2.jpg", "10.jpg", "11.jpg"}
	for i := 0; i < len(ordered)-1; i++ {
		a, b := ordered[i], ordered[i+1]
		if !naturalLess(strings.ToLower(a), strings.ToLower(b), a, b) {
			t.Fatalf("expected %q < %q", a, b)
		}
	}
}

func TestPageTooLargeFolder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.png")
	// maxPageBytes+1 of zeros is fine for limit enforcement.
	if err := os.WriteFile(path, make([]byte, maxPageBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	// small sibling remains rpc delivery
	if err := os.WriteFile(filepath.Join(dir, "small.png"), tinyPNG(1), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := openPageSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	// natural order: huge.png before small.png? "huge" < "small" so huge=0, small=1
	// actually naturalLess lowercases: huge vs small -> h < s, so 0=huge, 1=small
	var hugeIdx, smallIdx = -1, -1
	for i, name := range pageNames(src) {
		switch name {
		case "huge.png":
			hugeIdx = i
		case "small.png":
			smallIdx = i
		}
	}
	if hugeIdx < 0 || smallIdx < 0 {
		t.Fatalf("missing entries: names=%v", pageNames(src))
	}
	if d := src.PageDescriptor(hugeIdx); d.Delivery != deliveryStream {
		t.Fatalf("huge delivery=%q want stream", d.Delivery)
	}
	if d := src.PageDescriptor(smallIdx); d.Delivery != deliveryRPC {
		t.Fatalf("small delivery=%q want rpc", d.Delivery)
	}
	_, _, err = src.ReadPage(hugeIdx)
	if !errors.Is(err, errPageTooLarge) {
		t.Fatalf("want errPageTooLarge, got %v", err)
	}
}

func TestPageTooLargeArchive(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "huge.cbz")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("huge.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, maxPageBytes+1)); err != nil {
		t.Fatal(err)
	}
	w2, err := zw.Create("small.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w2.Write(tinyPNG(2)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	src, err := openPageSource(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	var hugeIdx, smallIdx = -1, -1
	for i, name := range pageNames(src) {
		switch name {
		case "huge.png":
			hugeIdx = i
		case "small.png":
			smallIdx = i
		}
	}
	if hugeIdx < 0 || smallIdx < 0 {
		t.Fatalf("missing entries: names=%v", pageNames(src))
	}
	if d := src.PageDescriptor(hugeIdx); d.Delivery != deliveryStream {
		t.Fatalf("huge delivery=%q want stream", d.Delivery)
	}
	if d := src.PageDescriptor(smallIdx); d.Delivery != deliveryRPC {
		t.Fatalf("small delivery=%q want rpc", d.Delivery)
	}
	_, _, err = src.ReadPage(hugeIdx)
	if !errors.Is(err, errPageTooLarge) {
		t.Fatalf("want errPageTooLarge, got %v", err)
	}
}

func TestMalformed7zAndRarOpen(t *testing.T) {
	// Truncated valid archives keep format identification deterministic
	// while failing open/walk without hanging on garbage payloads.
	for _, tc := range []struct {
		src    string
		suffix string
	}{
		{filepath.Join("testdata", "media-fixture.7z"), ".7z"},
		{filepath.Join("testdata", "media-fixture.7z"), ".cb7"},
		{filepath.Join("testdata", "media-fixture.cbr"), ".rar"},
		{filepath.Join("testdata", "media-fixture.cbr"), ".cbr"},
	} {
		data, err := os.ReadFile(tc.src)
		if err != nil {
			t.Fatal(err)
		}
		if len(data) < 32 {
			t.Fatalf("%s too small to truncate", tc.src)
		}
		path := filepath.Join(t.TempDir(), "bad"+tc.suffix)
		if err := os.WriteFile(path, data[:32], 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = openPageSource(path)
		if err == nil {
			t.Fatalf("%s: expected open error", tc.suffix)
		}
	}
}

func TestEmptyMediaArchive(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "empty.cbz")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("no media")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = openPageSource(zipPath)
	if !errors.Is(err, errNoSupportedMedia) {
		t.Fatalf("want errNoSupportedMedia, got %v", err)
	}
}

func TestTitleFromPathArchiveExts(t *testing.T) {
	cases := map[string]string{
		"/tmp/Foo.cbz": "Foo",
		"/tmp/Bar.ZIP": "Bar",
		"/tmp/Baz.cbr": "Baz",
		"/tmp/Qux.rar": "Qux",
		"/tmp/A.cb7":   "A",
		"/tmp/B.7z":    "B",
		"/tmp/folder":  "folder",
	}
	for in, want := range cases {
		if got := titleFromPath(in); got != want {
			t.Fatalf("titleFromPath(%q)=%q want %q", in, got, want)
		}
	}
}

func writeMinimalPDF(t *testing.T, path string, pages int) {
	t.Helper()
	if pages < 1 {
		t.Fatalf("pages must be >= 1, got %d", pages)
	}
	// Minimal multi-page PDF sufficient for pdfcpu PageCountFile.
	var (
		kids         []int
		pageIDs      []int
		contentIDs   []int
		contentBodies [][]byte
	)
	nextID := 3
	for i := 0; i < pages; i++ {
		contentID := nextID
		pageID := nextID + 1
		nextID += 2
		contentBodies = append(contentBodies, []byte(fmt.Sprintf("BT /F1 12 Tf 100 700 Td (Page %d) Tj ET", i+1)))
		contentIDs = append(contentIDs, contentID)
		pageIDs = append(pageIDs, pageID)
		kids = append(kids, pageID)
	}
	fontID := nextID

	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	offsets := map[int]int{0: 0}
	writeObj := func(num int, body string) {
		offsets[num] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", num, body)
	}
	writeObj(1, "<< /Type /Catalog /Pages 2 0 R >>")
	kidRefs := make([]string, len(kids))
	for i, k := range kids {
		kidRefs[i] = fmt.Sprintf("%d 0 R", k)
	}
	writeObj(2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kidRefs, " "), pages))
	writeObj(fontID, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	for i, pageID := range pageIDs {
		writeObj(pageID, fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>",
			contentIDs[i], fontID,
		))
	}
	for i, contentID := range contentIDs {
		body := contentBodies[i]
		offsets[contentID] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", contentID, len(body), body)
	}
	xrefPos := out.Len()
	maxObj := fontID
	for _, id := range contentIDs {
		if id > maxObj {
			maxObj = id
		}
	}
	for _, id := range pageIDs {
		if id > maxObj {
			maxObj = id
		}
	}
	fmt.Fprintf(&out, "xref\n0 %d\n", maxObj+1)
	out.WriteString("0000000000 65535 f \n")
	for i := 1; i <= maxObj; i++ {
		fmt.Fprintf(&out, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", maxObj+1, xrefPos)
	if err := os.WriteFile(path, out.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOpenStandaloneMarkdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.md")
	body := []byte("# Hello\n\n- one\n")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := openPageSource(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeMedia {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 1 {
		t.Fatalf("page count: %d", src.PageCount())
	}
	desc := src.PageDescriptor(0)
	if desc.Mime != "text/markdown" {
		t.Fatalf("mime: %q", desc.Mime)
	}
	if desc.DocumentPage != 0 || desc.DocumentKey != "" {
		t.Fatalf("document fields: %+v", desc)
	}
	mime, data, err := src.ReadPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "text/markdown" || !bytes.Equal(data, body) {
		t.Fatalf("read: mime=%q data=%q", mime, data)
	}
}

func TestOpenStandalonePDF(t *testing.T) {
	path := filepath.Join(t.TempDir(), "doc.pdf")
	writeMinimalPDF(t, path, 3)

	src, err := openPageSource(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeMedia {
		t.Fatalf("source type: got %q", src.SourceType())
	}
	if src.PageCount() != 3 {
		t.Fatalf("page count: %d", src.PageCount())
	}
	if src.Title() != "doc.pdf" {
		t.Fatalf("title: %q", src.Title())
	}
	var firstKey string
	for i := 0; i < 3; i++ {
		desc := src.PageDescriptor(i)
		if desc.Mime != "application/pdf" {
			t.Fatalf("page %d mime: %q", i, desc.Mime)
		}
		if desc.DocumentPage != i+1 {
			t.Fatalf("page %d DocumentPage: %d", i, desc.DocumentPage)
		}
		if desc.DocumentKey == "" {
			t.Fatalf("page %d missing DocumentKey", i)
		}
		if i == 0 {
			firstKey = desc.DocumentKey
		} else if desc.DocumentKey != firstKey {
			t.Fatalf("document key mismatch: %q vs %q", desc.DocumentKey, firstKey)
		}
		mime, data, err := src.ReadPage(i)
		if err != nil {
			t.Fatal(err)
		}
		if mime != "application/pdf" || len(data) == 0 {
			t.Fatalf("read page %d: mime=%q len=%d", i, mime, len(data))
		}
	}
}

func TestOpenFolderMixedDocsAndImages(t *testing.T) {
	dir := t.TempDir()
	writePNG(t, filepath.Join(dir, "a.png"), 0x22)
	writeMinimalPDF(t, filepath.Join(dir, "b.pdf"), 2)
	if err := os.WriteFile(filepath.Join(dir, "c.md"), []byte("# c\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	src, err := openPageSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeFolder {
		t.Fatalf("source type: %q", src.SourceType())
	}
	// a.png, b.pdf x2, c.md
	if src.PageCount() != 4 {
		t.Fatalf("page count: %d names=%v", src.PageCount(), pageNames(src))
	}
	want := []struct {
		rel  string
		mime string
		page int
		key  string
	}{
		{"a.png", "image/png", 0, ""},
		{"b.pdf", "application/pdf", 1, "b.pdf"},
		{"b.pdf", "application/pdf", 2, "b.pdf"},
		{"c.md", "text/markdown", 0, ""},
	}
	names := pageNames(src)
	for i, tc := range want {
		if names[i] != tc.rel {
			t.Fatalf("name[%d]=%q want %q (all=%v)", i, names[i], tc.rel, names)
		}
		desc := src.PageDescriptor(i)
		if desc.Mime != tc.mime || desc.DocumentPage != tc.page || desc.DocumentKey != tc.key {
			t.Fatalf("desc[%d]=%+v want mime=%s page=%d key=%q", i, desc, tc.mime, tc.page, tc.key)
		}
	}
}

func TestFolderSkipsCorruptPDF(t *testing.T) {
	dir := t.TempDir()
	writePNG(t, filepath.Join(dir, "ok.png"), 0x33)
	if err := os.WriteFile(filepath.Join(dir, "bad.pdf"), []byte("%PDF-not-a-real-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := openPageSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.PageCount() != 1 {
		t.Fatalf("page count: %d names=%v", src.PageCount(), pageNames(src))
	}
	if pageNames(src)[0] != "ok.png" {
		t.Fatalf("names: %v", pageNames(src))
	}
}

func TestStandaloneCorruptPDF(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.pdf")
	if err := os.WriteFile(path, []byte("%PDF-not-a-real-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openPageSource(path)
	if err == nil {
		t.Fatal("expected error for corrupt PDF")
	}
	if !strings.Contains(err.Error(), "could not open PDF") {
		t.Fatalf("error: %v", err)
	}
}

func TestOpenCommittedDocsFixture(t *testing.T) {
	mdPath := filepath.Join("testdata", "docs-fixture", "hello.md")
	pdfPath := filepath.Join("testdata", "docs-fixture", "sample.pdf")

	mdSrc, err := openPageSource(mdPath)
	if err != nil {
		t.Fatal(err)
	}
	defer mdSrc.Close()
	if mdSrc.PageCount() != 1 || mdSrc.PageDescriptor(0).Mime != "text/markdown" {
		t.Fatalf("md: pages=%d mime=%q", mdSrc.PageCount(), mdSrc.PageDescriptor(0).Mime)
	}
	mime, data, err := mdSrc.ReadPage(0)
	if err != nil || mime != "text/markdown" || !bytes.Contains(data, []byte("# Hello Komika")) {
		t.Fatalf("md read: mime=%q err=%v data=%q", mime, err, data)
	}

	pdfSrc, err := openPageSource(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	defer pdfSrc.Close()
	if pdfSrc.PageCount() < 2 {
		t.Fatalf("pdf pages: %d", pdfSrc.PageCount())
	}
	if pdfSrc.PageDescriptor(0).DocumentPage != 1 || pdfSrc.PageDescriptor(0).Mime != "application/pdf" {
		t.Fatalf("pdf desc0: %+v", pdfSrc.PageDescriptor(0))
	}
}

func TestOpenArchiveWithPDFExpansion(t *testing.T) {
	dir := t.TempDir()
	pdfPath := filepath.Join(dir, "inner.pdf")
	writeMinimalPDF(t, pdfPath, 2)
	pdfBytes, err := os.ReadFile(pdfPath)
	if err != nil {
		t.Fatal(err)
	}

	zipPath := filepath.Join(dir, "docs.cbz")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("pages/a.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(tinyPNG(0x44)); err != nil {
		t.Fatal(err)
	}
	w, err = zw.Create("pages/b.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(pdfBytes); err != nil {
		t.Fatal(err)
	}
	w, err = zw.Create("pages/c.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("# note\n")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	src, err := openPageSource(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if src.SourceType() != sourceTypeArchive {
		t.Fatalf("type: %q", src.SourceType())
	}
	// a.png + b.pdf x2 + c.md
	if src.PageCount() != 4 {
		t.Fatalf("pages: %d names=%v", src.PageCount(), pageNames(src))
	}
	names := pageNames(src)
	if names[0] != "pages/a.png" || names[1] != "pages/b.pdf" || names[2] != "pages/b.pdf" || names[3] != "pages/c.md" {
		t.Fatalf("names: %v", names)
	}
	d1 := src.PageDescriptor(1)
	d2 := src.PageDescriptor(2)
	if d1.Mime != "application/pdf" || d1.DocumentPage != 1 || d1.DocumentKey != "pages/b.pdf" {
		t.Fatalf("desc1: %+v", d1)
	}
	if d2.DocumentPage != 2 || d2.DocumentKey != d1.DocumentKey {
		t.Fatalf("desc2: %+v", d2)
	}
	mime, data, err := src.ReadPage(1)
	if err != nil || mime != "application/pdf" || len(data) == 0 {
		t.Fatalf("read: mime=%q len=%d err=%v", mime, len(data), err)
	}
}
