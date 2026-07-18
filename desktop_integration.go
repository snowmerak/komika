package main

// DesktopIntegrationStatus describes Linux XDG open-with registration state.
type DesktopIntegrationStatus struct {
	Supported   bool   `json:"supported"`
	Installed   bool   `json:"installed"`
	DesktopPath string `json:"desktopPath,omitempty"`
	MimePath    string `json:"mimePath,omitempty"`
	ExecPath    string `json:"execPath,omitempty"`
	Detail      string `json:"detail,omitempty"`
}
