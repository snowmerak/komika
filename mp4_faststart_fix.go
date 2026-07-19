package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ensureFaststartMP4 remuxes path to a temp MP4 with +faststart (moov before mdat).
// Caller owns the returned path and must delete it with stream temp accounting.
func (s *ComicService) ensureFaststartMP4(srcPath, mime string) (string, error) {
	ffmpeg, err := lookFFmpegPath()
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "komika-faststart-*")
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, "faststart.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Keep A/V; drop data/tmcd-like extras by mapping only A/V.
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-hide_banner", "-loglevel", "error",
		"-y",
		"-i", srcPath,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-c", "copy",
		"-movflags", "+faststart",
		out,
	)
	outb, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", fmt.Errorf("faststart remux: %w: %s", err, truncate(string(outb), 400))
	}
	// flatten: move file up and remove dir later via Remove on file only — keep dir with file
	// stream cleanup removes streamPath file; also try remove parent if empty in retire
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
