//go:build linux

package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed build/appicon.png
var appIconPNG []byte

const (
	desktopFileName = "komika.desktop"
	mimePackageName = "komika.xml"
	iconRelPath     = "icons/hicolor/256x256/apps/komika.png"
)

const comicMimeXML = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/vnd.comicbook+zip">
    <comment>Comic Book Zip Archive</comment>
    <glob pattern="*.cbz"/>
  </mime-type>
  <mime-type type="application/vnd.comicbook-rar">
    <comment>Comic Book RAR Archive</comment>
    <glob pattern="*.cbr"/>
  </mime-type>
  <mime-type type="application/x-cb7">
    <comment>Comic Book 7z Archive</comment>
    <glob pattern="*.cb7"/>
  </mime-type>
</mime-info>
`

const desktopMimeTypeLine = "application/vnd.comicbook+zip;application/vnd.comicbook-rar;application/x-cb7;application/zip;application/x-rar-compressed;application/vnd.rar;application/x-7z-compressed;application/pdf;text/markdown;text/x-markdown;image/jpeg;image/png;image/webp;image/gif;video/webm;video/mp4;video/quicktime;audio/mpeg;audio/mp4;audio/aac;audio/ogg;audio/opus;audio/wav;"

func xdgDataHome() (string, error) {
	if v := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share"), nil
}

func desktopIntegrationPaths() (desktopPath, mimePath, iconPath string, err error) {
	base, err := xdgDataHome()
	if err != nil {
		return "", "", "", err
	}
	return filepath.Join(base, "applications", desktopFileName),
		filepath.Join(base, "mime", "packages", mimePackageName),
		filepath.Join(base, iconRelPath),
		nil
}

func resolveIntegrationExec() (string, error) {
	if appImage := strings.TrimSpace(os.Getenv("APPIMAGE")); appImage != "" {
		if st, err := os.Stat(appImage); err == nil && st.Mode().IsRegular() {
			if filepath.IsAbs(appImage) {
				return appImage, nil
			}
			abs, err := filepath.Abs(appImage)
			if err != nil {
				return "", err
			}
			return abs, nil
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		resolved = exe
	}
	abs, err := filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("executable is not a regular file: %s", abs)
	}
	return abs, nil
}

// quoteDesktopExec escapes a path for a desktop-entry Exec key (spaces etc.).
func quoteDesktopExec(path string) string {
	if path == "" {
		return path
	}
	if !strings.ContainsAny(path, " \t\"'\\><~|&;$*?#()`") {
		return path
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range path {
		switch r {
		case '"', '\\', '`', '$':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func buildDesktopEntry(execPath string) string {
	return strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.0",
		"Name=Komika",
		"Exec=" + quoteDesktopExec(execPath) + " %F",
		"Icon=komika",
		"Terminal=false",
		"Categories=Graphics;Viewer;",
		"MimeType=" + desktopMimeTypeLine,
		"StartupWMClass=komika",
		"",
	}, "\n")
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".komika-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func runUpdateTools(dataHome string) string {
	var missing []string
	mimeDir := filepath.Join(dataHome, "mime")
	appDir := filepath.Join(dataHome, "applications")

	if path, err := exec.LookPath("update-mime-database"); err != nil {
		missing = append(missing, "update-mime-database")
	} else {
		_ = exec.Command(path, mimeDir).Run()
	}
	if path, err := exec.LookPath("update-desktop-database"); err != nil {
		missing = append(missing, "update-desktop-database")
	} else {
		_ = exec.Command(path, appDir).Run()
	}
	if len(missing) == 2 {
		return "update-mime-database and update-desktop-database not found; log out or refresh file manager may be required"
	}
	if len(missing) == 1 {
		return missing[0] + " not found; associations may need a session refresh"
	}
	return ""
}

func parseDesktopExec(desktopContents string) string {
	for _, line := range strings.Split(desktopContents, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Exec=") {
			continue
		}
		val := strings.TrimSpace(strings.TrimPrefix(line, "Exec="))
		// Strip field codes and trailing args; keep first token (possibly quoted).
		fields := splitDesktopExec(val)
		if len(fields) == 0 {
			return ""
		}
		return fields[0]
	}
	return ""
}

func splitDesktopExec(val string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escape := false
	for _, r := range val {
		if escape {
			cur.WriteRune(r)
			escape = false
			continue
		}
		if r == '\\' && inQuote {
			escape = true
			continue
		}
		if r == '"' {
			inQuote = !inQuote
			continue
		}
		if !inQuote && (r == ' ' || r == '\t') {
			if cur.Len() > 0 {
				tok := cur.String()
				cur.Reset()
				if strings.HasPrefix(tok, "%") {
					continue
				}
				out = append(out, tok)
			}
			continue
		}
		cur.WriteRune(r)
	}
	if cur.Len() > 0 {
		tok := cur.String()
		if !strings.HasPrefix(tok, "%") {
			out = append(out, tok)
		}
	}
	return out
}

func getDesktopIntegration() (DesktopIntegrationStatus, error) {
	status := DesktopIntegrationStatus{Supported: true}
	desktopPath, mimePath, _, err := desktopIntegrationPaths()
	if err != nil {
		status.Detail = err.Error()
		return status, nil
	}
	status.DesktopPath = desktopPath
	status.MimePath = mimePath

	execPath, err := resolveIntegrationExec()
	if err != nil {
		status.Detail = err.Error()
		return status, nil
	}
	status.ExecPath = execPath

	data, err := os.ReadFile(desktopPath)
	if err != nil {
		if os.IsNotExist(err) {
			status.Installed = false
			return status, nil
		}
		status.Detail = err.Error()
		return status, nil
	}
	status.Installed = true
	registered := parseDesktopExec(string(data))
	if registered != "" && registered != execPath {
		status.Detail = "Registered executable differs from this binary; re-install recommended"
	}
	return status, nil
}

func installDesktopIntegration() (DesktopIntegrationStatus, error) {
	execPath, err := resolveIntegrationExec()
	if err != nil {
		return DesktopIntegrationStatus{Supported: true, Detail: err.Error()}, err
	}
	desktopPath, mimePath, iconPath, err := desktopIntegrationPaths()
	if err != nil {
		return DesktopIntegrationStatus{Supported: true, Detail: err.Error()}, err
	}
	dataHome, err := xdgDataHome()
	if err != nil {
		return DesktopIntegrationStatus{Supported: true, Detail: err.Error()}, err
	}

	if err := writeFileAtomic(mimePath, []byte(comicMimeXML), 0o644); err != nil {
		return DesktopIntegrationStatus{Supported: true, ExecPath: execPath, Detail: err.Error()}, err
	}
	if len(appIconPNG) == 0 {
		err := fmt.Errorf("embedded app icon is empty")
		return DesktopIntegrationStatus{Supported: true, ExecPath: execPath, Detail: err.Error()}, err
	}
	if err := writeFileAtomic(iconPath, appIconPNG, 0o644); err != nil {
		return DesktopIntegrationStatus{Supported: true, ExecPath: execPath, Detail: err.Error()}, err
	}
	desktop := buildDesktopEntry(execPath)
	if err := writeFileAtomic(desktopPath, []byte(desktop), 0o644); err != nil {
		return DesktopIntegrationStatus{Supported: true, ExecPath: execPath, Detail: err.Error()}, err
	}

	detail := runUpdateTools(dataHome)
	return DesktopIntegrationStatus{
		Supported:   true,
		Installed:   true,
		DesktopPath: desktopPath,
		MimePath:    mimePath,
		ExecPath:    execPath,
		Detail:      detail,
	}, nil
}

func removeDesktopIntegration() (DesktopIntegrationStatus, error) {
	desktopPath, mimePath, iconPath, err := desktopIntegrationPaths()
	if err != nil {
		return DesktopIntegrationStatus{Supported: true, Detail: err.Error()}, err
	}
	dataHome, err := xdgDataHome()
	if err != nil {
		return DesktopIntegrationStatus{Supported: true, Detail: err.Error()}, err
	}

	for _, p := range []string{desktopPath, mimePath, iconPath} {
		if rmErr := os.Remove(p); rmErr != nil && !os.IsNotExist(rmErr) {
			return DesktopIntegrationStatus{
				Supported:   true,
				DesktopPath: desktopPath,
				MimePath:    mimePath,
				Detail:      rmErr.Error(),
			}, rmErr
		}
	}
	detail := runUpdateTools(dataHome)
	execPath, _ := resolveIntegrationExec()
	return DesktopIntegrationStatus{
		Supported:   true,
		Installed:   false,
		DesktopPath: desktopPath,
		MimePath:    mimePath,
		ExecPath:    execPath,
		Detail:      detail,
	}, nil
}

