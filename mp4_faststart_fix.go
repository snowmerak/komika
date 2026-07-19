package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type faststartFile struct {
	path string
	size int64
	dir  string // komika-faststart-* parent; remove with removeFaststartTree
}

// ensureFaststartMP4 remuxes path to a temp MP4 with +faststart (moov before mdat).
// Caller must account size via adoptFaststartTempLocked and delete via removeFaststartTree.
func (s *ComicService) ensureFaststartMP4(srcPath string) (*faststartFile, error) {
	ffmpeg, err := lookFFmpegPath()
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "komika-faststart-*")
	if err != nil {
		return nil, err
	}
	out := filepath.Join(dir, "faststart.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
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
		return nil, fmt.Errorf("faststart remux: %w: %s", err, truncateForLog(string(outb), 400))
	}
	st, err := os.Stat(out)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &faststartFile{path: out, size: st.Size(), dir: dir}, nil
}

func removeFaststartTree(path string) {
	if path == "" {
		return
	}
	parent := filepath.Dir(path)
	_ = os.Remove(path)
	if base := filepath.Base(parent); strings.HasPrefix(base, "komika-faststart-") {
		_ = os.RemoveAll(parent)
		return
	}
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
