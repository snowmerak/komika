package main

import (
	"bytes"
	"errors"
	"image"
	"net/http"
	"path/filepath"
	"testing"
)

func TestGetUpscaledStreamRendersAndReleasesTile(t *testing.T) {
	svc := testService(t)
	comic, err := svc.openPath(filepath.Join("testdata", "reader-fixture"), false)
	if err != nil {
		t.Fatal(err)
	}
	if comic.PageCount < 1 {
		t.Fatal("fixture has no pages")
	}

	stream, err := svc.GetUpscaledStream(UpscaleRequest{
		PageIndex:    0,
		Rendering:    "highQuality",
		SourceX:      0,
		SourceY:      0,
		SourceWidth:  1,
		SourceHeight: 1,
		DestWidth:    8,
		DestHeight:   6,
	})
	if err != nil {
		t.Fatal(err)
	}
	if stream.Mime != "image/png" || stream.Token == "" || stream.URL == "" {
		t.Fatalf("stream=%+v", stream)
	}

	rr := serveMediaRequest(svc, http.MethodGet, stream.URL, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(rr.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if format != "png" || config.Width != 8 || config.Height != 6 {
		t.Fatalf("format=%q size=%dx%d", format, config.Width, config.Height)
	}

	if err := svc.ReleasePageStream(stream.Token); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if svc.archiveTempBytes != 0 || len(svc.streams) != 0 {
		t.Fatalf("temp=%d streams=%d", svc.archiveTempBytes, len(svc.streams))
	}
	if got := len(svc.upscaleDecoded); got != 1 {
		t.Fatalf("decoded upscale cache entries = %d, want 1", got)
	}
	if svc.upscaleDecodedBytes <= 0 {
		t.Fatal("decoded upscale cache byte accounting was not retained")
	}
}

func TestGetUpscaledStreamValidatesRequest(t *testing.T) {
	svc := testService(t)
	if _, err := svc.openPath(filepath.Join("testdata", "reader-fixture"), false); err != nil {
		t.Fatal(err)
	}

	base := UpscaleRequest{
		PageIndex:    0,
		Rendering:    "highQuality",
		SourceWidth:  1,
		SourceHeight: 1,
		DestWidth:    8,
		DestHeight:   8,
	}
	badRendering := base
	badRendering.Rendering = "xbrz"
	if _, err := svc.GetUpscaledStream(badRendering); !errors.Is(err, errUpscaleUnsupported) {
		t.Fatalf("rendering error=%v", err)
	}
	badSize := base
	badSize.DestWidth = maxUpscaleDestSide + 1
	if _, err := svc.GetUpscaledStream(badSize); !errors.Is(err, errUpscaleBounds) {
		t.Fatalf("size error=%v", err)
	}
	badPage := base
	badPage.PageIndex = 999
	if _, err := svc.GetUpscaledStream(badPage); !errors.Is(err, errPageOutOfRange) {
		t.Fatalf("page error=%v", err)
	}
}

func TestUpscaleDecodeCacheInvalidatesOnSourceSwitch(t *testing.T) {
	svc := testService(t)
	fixture := filepath.Join("testdata", "reader-fixture")
	if _, err := svc.openPath(fixture, false); err != nil {
		t.Fatal(err)
	}
	stream, err := svc.GetUpscaledStream(UpscaleRequest{
		PageIndex: 0, Rendering: "highQuality",
		SourceWidth: 1, SourceHeight: 1, DestWidth: 2, DestHeight: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ReleasePageStream(stream.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.openPath(fixture, false); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if len(svc.upscaleDecoded) != 0 || svc.upscaleDecodedBytes != 0 {
		t.Fatalf("cache survived source switch: entries=%d bytes=%d", len(svc.upscaleDecoded), svc.upscaleDecodedBytes)
	}
}
