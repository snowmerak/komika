package main

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// associatedFileExts is the OS open-with + Wails FileAssociations filter.
// Keep in sync with comic_source supported archive/media maps and packaging lists.
var associatedFileExts = []string{
	".cbz", ".zip", ".cbr", ".rar", ".cb7", ".7z",
	".pdf", ".md", ".markdown",
	".jpg", ".jpeg", ".png", ".webp", ".gif",
	".webm", ".mp4", ".mov",
	".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav",
}

var associatedExtSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(associatedFileExts))
	for _, ext := range associatedFileExts {
		set[ext] = struct{}{}
	}
	return set
}()

var (
	openReqMu       sync.Mutex
	pendingOpenPath string
	mainWindow      *application.WebviewWindow
)

func isAssociatedExt(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	_, ok := associatedExtSet[ext]
	return ok
}

// firstAssociatedPath returns the first argv path with an associated extension.
// When len(args) > 1, args[0] is treated as the executable and skipped.
// Relative paths are resolved against workingDir when provided.
func firstAssociatedPath(args []string, workingDir string) string {
	if len(args) == 0 {
		return ""
	}
	start := 0
	if len(args) > 1 {
		start = 1
	}
	for _, raw := range args[start:] {
		arg := strings.TrimSpace(raw)
		arg = strings.Trim(arg, `"'`)
		if arg == "" {
			continue
		}
		path := arg
		if !filepath.IsAbs(path) && workingDir != "" {
			path = filepath.Join(workingDir, path)
		}
		if isAssociatedExt(path) {
			return path
		}
	}
	return ""
}

// requestOpenPath queues path for the frontend and emits files-dropped when the app is live.
func requestOpenPath(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	openReqMu.Lock()
	pendingOpenPath = path
	openReqMu.Unlock()

	if app := application.Get(); app != nil {
		app.Event.Emit("files-dropped", map[string]any{
			"files": []string{path},
		})
	}
}

// consumePendingOpenPath returns and clears any path queued by OS open-with / second instance.
func consumePendingOpenPath() string {
	openReqMu.Lock()
	defer openReqMu.Unlock()
	path := pendingOpenPath
	pendingOpenPath = ""
	return path
}
