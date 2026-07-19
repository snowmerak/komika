package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMp4MoovBeforeMdat(t *testing.T) {
	// fixture webm is not mp4 - use media fixture mp4 if any
	src := filepath.Join("testdata", "media-fixture", "8-video.mp4")
	ok, err := mp4MoovBeforeMdat(src)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture faststart=%v", ok)

	android := "/media/veracrypt1/video/7c27eeeacdf685a5b5ea445e9d65b10c1bb963739a744b5a6de2cd2b08d9e505.mp4"
	if _, err := os.Stat(android); err == nil {
		ok, err := mp4MoovBeforeMdat(android)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("android sample should be moov-at-end")
		}
	}

	// remuxed should be faststart
	if _, err := os.Stat("/tmp/android-remux.mp4"); err == nil {
		ok, err := mp4MoovBeforeMdat("/tmp/android-remux.mp4")
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("remux should be faststart")
		}
	}

	// create non-faststart via ffmpeg if available
	if _, err := exec.LookPath("ffmpeg"); err == nil {
		dir := t.TempDir()
		out := filepath.Join(dir, "nofast.mp4")
		// copy without faststart from fixture
		cmd := exec.Command("ffmpeg", "-hide_banner", "-y", "-i", src, "-c", "copy", out)
		if err := cmd.Run(); err == nil {
			// may or may not be faststart depending on source
			_, _ = mp4MoovBeforeMdat(out)
		}
	}
}
