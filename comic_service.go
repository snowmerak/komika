package main

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ComicService is the sole Wails bridge boundary for local comics.
type ComicService struct {
	mu     sync.Mutex
	active *sourceSlot
	store  *LibraryStore

	// nextGeneration is monotonically increased for each successful open.
	nextGeneration uint64

	// Stream capability registry and archive temp-cache accounting.
	streams                 map[string]*streamEntry
	maxArchiveStreamBytes   int64
	maxArchiveTempBytes     int64
	archiveTempBytes        int64
	archiveTempPendingBytes int64
}

// NewComicService constructs the service with the default library store.
func NewComicService() (*ComicService, error) {
	store, err := NewLibraryStore()
	if err != nil {
		return nil, err
	}
	svc := &ComicService{store: store}
	initStreamState(svc)
	return svc, nil
}

// NewComicServiceWithStore is used by tests.
func NewComicServiceWithStore(store *LibraryStore) *ComicService {
	svc := &ComicService{store: store}
	initStreamState(svc)
	return svc
}

// OpenArchive prompts for a supported comic archive and opens it.
func (s *ComicService) OpenArchive() (*Comic, error) {
	app := application.Get()
	if app == nil {
		return nil, errors.New("application not ready")
	}
	path, err := app.Dialog.OpenFile().
		SetTitle("Open comic archive").
		CanChooseFiles(true).
		CanChooseDirectories(false).
		AddFilter("Comic archives", "*.cbz;*.zip;*.cbr;*.rar;*.cb7;*.7z").
		PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("open cancelled")
	}
	return s.openPath(path, false)
}

// OpenFolder prompts for an image folder and opens it.
func (s *ComicService) OpenFolder() (*Comic, error) {
	app := application.Get()
	if app == nil {
		return nil, errors.New("application not ready")
	}
	path, err := app.Dialog.OpenFile().
		SetTitle("Open comic folder").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("open cancelled")
	}
	return s.openPath(path, false)
}

// OpenMedia prompts for a supported image, GIF, video, or audio file and opens it.
func (s *ComicService) OpenMedia() (*Comic, error) {
	app := application.Get()
	if app == nil {
		return nil, errors.New("application not ready")
	}
	path, err := app.Dialog.OpenFile().
		SetTitle("Open media").
		CanChooseFiles(true).
		CanChooseDirectories(false).
		AddFilter("Images, video, and audio", "*.jpg;*.jpeg;*.png;*.webp;*.gif;*.webm;*.mp4;*.mov;*.mp3;*.m4a;*.aac;*.ogg;*.opus;*.wav").
		PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("open cancelled")
	}
	return s.OpenPath(path)
}

// OpenPath opens a folder, archive, or standalone supported media file.
// Unlike OpenRecent, a missing path does not mutate recents.
func (s *ComicService) OpenPath(path string) (*Comic, error) {
	if path == "" {
		return nil, errors.New("path is required")
	}
	return s.openPath(path, false)
}

// OpenRecent reopens a library path, removing it if the file is gone.
func (s *ComicService) OpenRecent(path string) (*Comic, error) {
	if path == "" {
		return nil, errors.New("path is required")
	}
	canonical, err := canonicalizePath(path)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(canonical); err != nil {
		if os.IsNotExist(err) {
			paths := []string{canonical}
			if canonical != path {
				paths = append(paths, path)
			}
			if remErr := s.store.RemoveMany(paths); remErr != nil {
				return nil, remErr
			}
			return nil, fmt.Errorf("comic no longer exists: %s", path)
		}
		return nil, err
	}
	return s.openPath(canonical, true)
}

// GetLibrary returns the current recents list.
func (s *ComicService) GetLibrary() (*LibraryState, error) {
	st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// RemoveRecents removes the given recent paths and returns a fresh snapshot.
func (s *ComicService) RemoveRecents(paths []string) (*LibraryState, error) {
	if err := s.store.RemoveMany(paths); err != nil {
		return nil, err
	}
	st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// ClearRecents clears all recents and returns a fresh snapshot.
func (s *ComicService) ClearRecents() (*LibraryState, error) {
	if err := s.store.Clear(); err != nil {
		return nil, err
	}
	st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// UpdateLibrarySettings updates privacy/retention settings and returns a fresh snapshot.
func (s *ComicService) UpdateLibrarySettings(settings LibrarySettings) (*LibraryState, error) {
	if err := s.store.UpdateSettings(settings); err != nil {
		return nil, err
	}
	st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// GetPage returns the encoded page for the active comic.
func (s *ComicService) GetPage(index int) (*PagePayload, error) {
	slot, err := s.acquireSourceLease()
	if err != nil {
		return nil, err
	}
	defer s.releaseSourceLease(slot)

	src := slot.source
	if index < 0 || index >= src.PageCount() {
		return nil, errPageOutOfRange
	}
	mime, data, err := src.ReadPage(index)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	active := s.active
	s.mu.Unlock()
	if active == nil || active.generation != slot.generation {
		return nil, errNoActiveComic
	}
	return encodePagePayload(index, mime, data), nil
}

// SetProgress persists a zero-based page index for the active comic.
func (s *ComicService) SetProgress(index int) error {
	s.mu.Lock()
	var (
		src  pageSource
		path string
	)
	if s.active != nil && s.active.source != nil {
		src = s.active.source
		path = src.Path()
	}
	s.mu.Unlock()

	if src == nil {
		return errNoActiveComic
	}
	if index < 0 || index >= src.PageCount() {
		return errPageOutOfRange
	}
	return s.store.SetProgress(path, index)
}

// openPath validates, scans, restores progress, replaces the active source, and upserts recents.
// removeOnMissing is reserved for OpenRecent (already handled before call).
func (s *ComicService) openPath(path string, _ bool) (*Comic, error) {
	src, err := openPageSource(path)
	if err != nil {
		return nil, userFacingOpenError(err)
	}

	canonical := src.Path()
	saved, err := s.store.ProgressFor(canonical)
	if err != nil {
		_ = src.Close()
		return nil, err
	}
	// Also check the pre-canonical path key in case of legacy records.
	if saved == 0 {
		if abs, absErr := canonicalizePath(path); absErr == nil && abs != canonical {
			alt, altErr := s.store.ProgressFor(abs)
			if altErr != nil {
				_ = src.Close()
				return nil, altErr
			}
			saved = alt
		}
	}
	page := saved
	if page < 0 || page >= src.PageCount() {
		page = 0
	}

	s.mu.Lock()
	s.retireActiveLocked()
	s.promoteSourceLocked(src)
	s.mu.Unlock()

	if err := s.store.UpsertOpen(canonical, src.Title(), src.SourceType(), src.PageCount(), page); err != nil {
		return nil, err
	}

	return &Comic{
		Title:       src.Title(),
		SourceType:  src.SourceType(),
		PageCount:   src.PageCount(),
		CurrentPage: page,
		Pages:       pageDescriptors(src),
	}, nil
}

func userFacingOpenError(err error) error {
	if errors.Is(err, errNoSupportedMedia) {
		return errors.New("no supported image, video, or audio entries found in the selected source")
	}
	if errors.Is(err, errUnsupportedSource) {
		return errors.New("unsupported file type; open an archive, folder, or supported image/video/audio")
	}
	return err
}
