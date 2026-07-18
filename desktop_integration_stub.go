//go:build !linux

package main

func getDesktopIntegration() (DesktopIntegrationStatus, error) {
	return DesktopIntegrationStatus{
		Supported: false,
		Detail:    "Desktop integration is only available on Linux",
	}, nil
}

func installDesktopIntegration() (DesktopIntegrationStatus, error) {
	return getDesktopIntegration()
}

func removeDesktopIntegration() (DesktopIntegrationStatus, error) {
	return getDesktopIntegration()
}
