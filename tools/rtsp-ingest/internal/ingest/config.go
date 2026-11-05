// SPDX-License-Identifier: MIT

// Package ingest admits one bounded, literal-destination RTSP/TCP stream.
package ingest

import (
	"bytes"
	"encoding/json"
	"io"
	"net/netip"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Code is a public diagnostic without source, address, or upstream error text.
type Code string

func (c Code) Error() string { return string(c) }

const (
	ErrConfig Code = "INGEST_CONFIG"
	ErrPolicy Code = "INGEST_POLICY"
	ErrWire Code = "INGEST_WIRE"
	ErrRTP Code = "INGEST_RTP"
	ErrClock Code = "INGEST_CLOCK"
	ErrSource Code = "INGEST_SOURCE"
	ErrOutput Code = "INGEST_OUTPUT"
	ErrCanceled Code = "INGEST_CANCELED"
	ErrLease Code = "INGEST_LEASE"
)

type Destination struct {
	Addr netip.AddrPort
	Path string
}

type Config struct {
	Destination Destination
	Lease time.Duration
}

// ValidateConfig consumes a complete private JSON object, including its EOF.
func ValidateConfig(raw []byte) (Config, error) {
	if len(raw) == 0 || len(raw) > 2048 || !utf8.Valid(raw) {
		return Config{}, ErrConfig
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return Config{}, ErrConfig
	}
	var version, port, lease int
	var address, path string
	seen := make(map[string]bool, 5)
	for d.More() {
		token, err = d.Token()
		if err != nil { return Config{}, ErrConfig }
		key, ok := token.(string)
		if !ok || seen[key] { return Config{}, ErrConfig }
		seen[key] = true
		var target any
		switch key {
		case "version": target = &version
		case "address": target = &address
		case "port": target = &port
		case "path": target = &path
		case "leaseMs": target = &lease
		default: return Config{}, ErrConfig
		}
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, target) != nil {
			return Config{}, ErrConfig
		}
	}
	token, err = d.Token()
	if err != nil || token != json.Delim('}') || len(seen) != 5 { return Config{}, ErrConfig }
	if _, err = d.Token(); err != io.EOF { return Config{}, ErrConfig }
	addr, err := netip.ParseAddr(address)
	if err != nil || !validAddress(addr) || version != 1 || port < 1 || port > 65535 || lease < 1 || lease > 30000 || !validPath(path) {
		return Config{}, ErrConfig
	}
	return Config{Destination: Destination{Addr: netip.AddrPortFrom(addr, uint16(port)), Path: path}, Lease: time.Duration(lease)*time.Millisecond}, nil
}

func validAddress(addr netip.Addr) bool {
	return addr.IsValid() && addr.Zone() == "" && !addr.Is4In6() &&
		(addr.IsGlobalUnicast() || addr.IsLoopback() || addr.IsLinkLocalUnicast())
}

func validText(s string, max int) bool {
	if len(s) > max || !utf8.ValidString(s) { return false }
	for _, r := range s { if unicode.IsControl(r) { return false } }
	return true
}

func validPath(path string) bool {
	return strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "//") && validText(path, 1024) && !strings.ContainsAny(path, "?#@\\")
}

func validConfig(cfg Config) bool {
	return validAddress(cfg.Destination.Addr.Addr()) && cfg.Destination.Addr.Port() != 0 && validPath(cfg.Destination.Path) && cfg.Lease >= time.Millisecond && cfg.Lease <= 30*time.Second
}
