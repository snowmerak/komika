package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxRecents = 20

// RecentComic is one library entry shown on the landing view.
type RecentComic struct {
	Path        string `json:"path"` // canonical absolute path
	Title       string `json:"title"`
	SourceType  string `json:"sourceType"` // "archive" | "folder" | "media"
	PageCount   int    `json:"pageCount"`
	CurrentPage int    `json:"currentPage"` // zero-based
	LastOpened  string `json:"lastOpened"`  // RFC 3339 UTC
}

// LibrarySettings controls recent retention and privacy.
type LibrarySettings struct {
	SaveRecents   bool `json:"saveRecents"`
	RetentionDays int  `json:"retentionDays"` // exactly 0, 7, 30, or 90; 0 means no expiry
}

// LibraryState is the full persisted library payload.
type LibraryState struct {
	Recents  []RecentComic   `json:"recents"`
	Settings LibrarySettings `json:"settings"`
}

// diskLibrary is the unexported load DTO that tolerates a missing settings object.
type diskLibrary struct {
	Recents  []RecentComic    `json:"recents"`
	Settings *LibrarySettings `json:"settings"`
}

// LibraryStore owns in-memory recents and atomic JSON persistence.
type LibraryStore struct {
	mu      sync.Mutex
	path    string
	state   LibraryState
	now     func() time.Time
	pending *LibraryState
}

// NewLibraryStore loads ${configDir}/komika/library.json.
// configDir may be overridden in tests via NewLibraryStoreAt.
func NewLibraryStore() (*LibraryStore, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return NewLibraryStoreAt(filepath.Join(cfg, "komika"))
}

// NewLibraryStoreAt loads/creates library.json under dir.
func NewLibraryStoreAt(dir string) (*LibraryStore, error) {
	return newLibraryStoreAt(dir, time.Now)
}

// newLibraryStoreAt is the testable constructor with an injectable clock.
func newLibraryStoreAt(dir string, now func() time.Time) (*LibraryStore, error) {
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "library.json")
	s := &LibraryStore{
		path:  path,
		state: defaultLibraryState(),
		now:   now,
	}
	if err := s.load(); err != nil {
		// Missing/corrupt store starts empty rather than blocking the viewer.
		s.state = defaultLibraryState()
		s.pending = nil
	}
	return s, nil
}

func defaultLibraryState() LibraryState {
	return LibraryState{
		Recents:  []RecentComic{},
		Settings: LibrarySettings{SaveRecents: true, RetentionDays: 0},
	}
}

func defaultSettings() LibrarySettings {
	return LibrarySettings{SaveRecents: true, RetentionDays: 0}
}

func isValidRetention(days int) bool {
	switch days {
	case 0, 7, 30, 90:
		return true
	default:
		return false
	}
}

func cloneState(st LibraryState) LibraryState {
	out := LibraryState{
		Settings: st.Settings,
		Recents:  make([]RecentComic, len(st.Recents)),
	}
	copy(out.Recents, st.Recents)
	if out.Recents == nil {
		out.Recents = []RecentComic{}
	}
	return out
}

func (s *LibraryStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var disk diskLibrary
	if err := json.Unmarshal(data, &disk); err != nil {
		return err
	}
	if disk.Recents == nil {
		disk.Recents = []RecentComic{}
	}

	// Raw decoded state (settings pointer resolved only if present; no retention normalize/prune).
	raw := LibraryState{Recents: append([]RecentComic(nil), disk.Recents...)}
	if disk.Settings == nil {
		// Missing settings: expose defaults in-memory so API consumers always see Settings.
		// Migration write still tracked via changed on candidate.
		raw.Settings = defaultSettings()
	} else {
		raw.Settings = *disk.Settings
	}
	if raw.Recents == nil {
		raw.Recents = []RecentComic{}
	}

	// Candidate applies all migrations/normalizations/pruning.
	candidate := LibraryState{
		Recents:  append([]RecentComic(nil), disk.Recents...),
		Settings: raw.Settings,
	}
	changed := false

	if disk.Settings == nil {
		candidate.Settings = defaultSettings()
		changed = true
	} else if !isValidRetention(candidate.Settings.RetentionDays) {
		candidate.Settings.RetentionDays = 0
		changed = true
	}

	if !candidate.Settings.SaveRecents && len(candidate.Recents) > 0 {
		candidate.Recents = []RecentComic{}
		changed = true
	}

	if pruneExpired(&candidate, s.now) {
		changed = true
	}

	if !changed {
		s.state = candidate
		s.pending = nil
		return nil
	}

	if err := s.persistLocked(candidate); err != nil {
		// Retain unmodified loaded state plus candidate in pending.
		s.state = raw
		pending := cloneState(candidate)
		s.pending = &pending
		return nil
	}
	s.state = candidate
	s.pending = nil
	return nil
}

// persistLocked marshals/writes/renames candidate first, then assigns s.state only on success.
// Caller must hold s.mu (except during construction load before concurrent access).
func (s *LibraryStore) persistLocked(candidate LibraryState) error {
	if candidate.Recents == nil {
		candidate.Recents = []RecentComic{}
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(candidate, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "library-*.tmp")
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
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return err
	}
	cleanup = false
	s.state = cloneState(candidate)
	return nil
}

// commitPendingLocked retries a previously failed migration/mutation write.
// Caller must hold s.mu.
func (s *LibraryStore) commitPendingLocked() error {
	if s.pending == nil {
		return nil
	}
	if err := s.persistLocked(*s.pending); err != nil {
		return err
	}
	s.pending = nil
	return nil
}

// applyAndPersist clones current state, runs mut, and persists once if changed.
// Caller must hold s.mu. On persist failure, s.state is unchanged and pending is set.
func (s *LibraryStore) applyAndPersist(mut func(st *LibraryState) bool) error {
	if err := s.commitPendingLocked(); err != nil {
		return err
	}
	candidate := cloneState(s.state)
	changed := false
	if pruneExpired(&candidate, s.now) {
		changed = true
	}
	if mut(&candidate) {
		changed = true
	}
	if !changed {
		return nil
	}
	if err := s.persistLocked(candidate); err != nil {
		pending := cloneState(candidate)
		s.pending = &pending
		return err
	}
	s.pending = nil
	return nil
}

// pruneExpired removes recents older than the retention window.
// Retention 0 means no expiry. Malformed timestamps are discarded.
// Returns true if any record was removed.
func pruneExpired(state *LibraryState, now func() time.Time) bool {
	days := state.Settings.RetentionDays
	if days == 0 {
		return false
	}
	if state.Recents == nil {
		return false
	}
	cutoff := now().UTC().AddDate(0, 0, -days)
	kept := make([]RecentComic, 0, len(state.Recents))
	changed := false
	for _, r := range state.Recents {
		ts, err := time.Parse(time.RFC3339, r.LastOpened)
		if err != nil {
			changed = true
			continue
		}
		if ts.UTC().Before(cutoff) {
			changed = true
			continue
		}
		kept = append(kept, r)
	}
	if changed {
		state.Recents = kept
	}
	return changed
}

// Get returns a deep copy of the current library state after applying pending writes and pruning.
func (s *LibraryStore) Get() (LibraryState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.commitPendingLocked(); err != nil {
		return LibraryState{}, err
	}
	candidate := cloneState(s.state)
	if pruneExpired(&candidate, s.now) {
		if err := s.persistLocked(candidate); err != nil {
			pending := cloneState(candidate)
			s.pending = &pending
			return LibraryState{}, err
		}
		s.pending = nil
	}
	return cloneState(s.state), nil
}

// UpsertOpen records a successful open: moves path to front, updates metadata.
// When saving is disabled, this is a no-op.
func (s *LibraryStore) UpsertOpen(path, title, sourceType string, pageCount, currentPage int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.applyAndPersist(func(st *LibraryState) bool {
		if !st.Settings.SaveRecents {
			return false
		}
		now := s.now().UTC().Format(time.RFC3339)
		filtered := make([]RecentComic, 0, len(st.Recents)+1)
		for _, r := range st.Recents {
			if r.Path == path {
				continue
			}
			filtered = append(filtered, r)
		}
		entry := RecentComic{
			Path:        path,
			Title:       title,
			SourceType:  sourceType,
			PageCount:   pageCount,
			CurrentPage: currentPage,
			LastOpened:  now,
		}
		filtered = append([]RecentComic{entry}, filtered...)
		if len(filtered) > maxRecents {
			filtered = filtered[:maxRecents]
		}
		st.Recents = filtered
		return true
	})
}

// SetProgress updates only the matching work's zero-based progress.
// When saving is disabled, this is a successful no-op.
func (s *LibraryStore) SetProgress(path string, index int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.commitPendingLocked(); err != nil {
		return err
	}

	candidate := cloneState(s.state)
	changed := false
	if pruneExpired(&candidate, s.now) {
		changed = true
	}

	if !candidate.Settings.SaveRecents {
		if !changed {
			return nil
		}
		if err := s.persistLocked(candidate); err != nil {
			pending := cloneState(candidate)
			s.pending = &pending
			return err
		}
		s.pending = nil
		return nil
	}

	found := false
	for i := range candidate.Recents {
		if candidate.Recents[i].Path == path {
			found = true
			if candidate.Recents[i].CurrentPage != index {
				candidate.Recents[i].CurrentPage = index
				changed = true
			}
			break
		}
	}
	if !found {
		// Persist prune-only changes first if needed, then report missing path.
		if changed {
			if err := s.persistLocked(candidate); err != nil {
				pending := cloneState(candidate)
				s.pending = &pending
				return err
			}
			s.pending = nil
		}
		return fmt.Errorf("path not in library: %s", path)
	}
	if !changed {
		return nil
	}
	if err := s.persistLocked(candidate); err != nil {
		pending := cloneState(candidate)
		s.pending = &pending
		return err
	}
	s.pending = nil
	return nil
}

// ProgressFor returns the saved zero-based page for path, or 0 if absent/disabled.
func (s *LibraryStore) ProgressFor(path string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.commitPendingLocked(); err != nil {
		return 0, err
	}
	candidate := cloneState(s.state)
	if pruneExpired(&candidate, s.now) {
		if err := s.persistLocked(candidate); err != nil {
			pending := cloneState(candidate)
			s.pending = &pending
			return 0, err
		}
		s.pending = nil
	}
	if !s.state.Settings.SaveRecents {
		return 0, nil
	}
	for _, r := range s.state.Recents {
		if r.Path == path {
			return r.CurrentPage, nil
		}
	}
	return 0, nil
}

// RemoveMany drops the given paths (unknown/duplicate paths are idempotent no-ops).
func (s *LibraryStore) RemoveMany(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	drop := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		if p != "" {
			drop[p] = struct{}{}
		}
	}
	if len(drop) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.applyAndPersist(func(st *LibraryState) bool {
		filtered := make([]RecentComic, 0, len(st.Recents))
		changed := false
		for _, r := range st.Recents {
			if _, ok := drop[r.Path]; ok {
				changed = true
				continue
			}
			filtered = append(filtered, r)
		}
		if changed {
			st.Recents = filtered
		}
		return changed
	})
}

// Clear removes every recent. Idempotent.
func (s *LibraryStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.applyAndPersist(func(st *LibraryState) bool {
		if len(st.Recents) == 0 {
			return false
		}
		st.Recents = []RecentComic{}
		return true
	})
}

// UpdateSettings validates and applies library settings.
// Disabling save immediately clears all recents.
// Settings are applied before pruning so a retention change (e.g. 0→7) and TTL prune share one write.
func (s *LibraryStore) UpdateSettings(settings LibrarySettings) error {
	if !isValidRetention(settings.RetentionDays) {
		return errors.New("invalid retention days")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.commitPendingLocked(); err != nil {
		return err
	}
	candidate := cloneState(s.state)
	changed := false
	if candidate.Settings.SaveRecents != settings.SaveRecents || candidate.Settings.RetentionDays != settings.RetentionDays {
		candidate.Settings = settings
		changed = true
	}
	if !settings.SaveRecents && len(candidate.Recents) > 0 {
		candidate.Recents = []RecentComic{}
		changed = true
	}
	// Prune after settings assignment so new retention takes effect in this write.
	if pruneExpired(&candidate, s.now) {
		changed = true
	}
	if !changed {
		return nil
	}
	if err := s.persistLocked(candidate); err != nil {
		pending := cloneState(candidate)
		s.pending = &pending
		return err
	}
	s.pending = nil
	return nil
}
