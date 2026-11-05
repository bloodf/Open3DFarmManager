// SPDX-License-Identifier: MIT

package ingest

import (
	"encoding/hex"
	"net/netip"
	"strconv"
	"strings"

	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/sdpunmarshaler"
	"github.com/pion/sdp/v3"
)

func sdpLimits() *sdpunmarshaler.Limits {
	return &sdpunmarshaler.Limits{
		MaxBodyBytes: 16384, MaxLineBytes: 2048, MaxLines: 64,
		MaxMediaDescriptions: 1, MaxFormatsPerMedia: 1, MaxAttributes: 32,
	}
}

func validateURL(u *base.URL, destination Destination) error {
	if u == nil || u.Scheme != "rtsp" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || !validPath(u.Path) || !validText(u.String(), 2048) {
		return ErrPolicy
	}
	addr, err := netip.ParseAddrPort(u.Host)
	if err != nil || addr != destination.Addr { return ErrPolicy }
	return nil
}

// Validate raw controls too: Media.URL rewrites absolute control hosts.
func validateControl(value string, destination Destination, session bool) error {
	if session && value == "*" { return nil }
	if value == "" || !validText(value, 1024) || strings.ContainsAny(value, "?#@\\") || strings.HasPrefix(value, "//") {
		return ErrPolicy
	}
	if session || strings.Contains(value, ":") {
		u, err := base.ParseURL(value)
		if err != nil { return ErrPolicy }
		return validateURL(u, destination)
	}
	// Resolve using the same upstream utility as SETUP, then gate the result.
	u := &base.URL{Scheme: "rtsp", Host: destination.Addr.String(), Path: destination.Path}
	resolved, err := (description.Media{Control: value}).URL(u)
	if err != nil { return ErrPolicy }
	return validateURL(resolved, destination)
}

func validateResponse(res *base.Response, destination Destination) error {
	if res == nil || res.StatusCode != base.StatusOK || len(res.Body) > 16384 { return ErrPolicy }
	for _, key := range []string{"Content-Base", "Content-Location"} {
		values, ok := res.Header[key]
		if !ok { continue }
		if len(values) != 1 { return ErrPolicy }
		value := values[0]
		if strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") {
			value = "rtsp://" + destination.Addr.String() + value
		}
		u, err := base.ParseURL(value)
		if err != nil || validateURL(u, destination) != nil { return ErrPolicy }
	}
	if len(res.Body) != 0 {
		ct := res.Header["Content-Type"]
		if len(ct) != 1 || ct[0] != "application/sdp" { return ErrPolicy }
	}
	return nil
}

func validSDPAddress(network, family, address string) bool {
	if network != "IN" { return false }
	ip, err := netip.ParseAddr(address)
	return err == nil && ip.Zone() == "" && !ip.Is4In6() && !ip.IsMulticast() &&
		(ip.IsUnspecified() || validAddress(ip)) &&
		((family == "IP4" && ip.Is4()) || (family == "IP6" && ip.Is6()))
}

func validConnection(c *sdp.ConnectionInformation) bool {
	return c == nil || (c.Address != nil && c.Address.TTL == nil && c.Address.Range == nil && validSDPAddress(c.NetworkType, c.AddressType, c.Address.Address))
}

// ValidateSDP runs on the bounded upstream parse before codec conversion.
func ValidateSDP(desc *sdp.SessionDescription, destination Destination) error {
	if desc == nil || desc.Version != 0 || !validText(string(desc.SessionName), 256) || len(desc.SessionName) == 0 ||
		!validText(desc.Origin.Username, 64) || desc.Origin.Username == "" || !validSDPAddress(desc.Origin.NetworkType, desc.Origin.AddressType, desc.Origin.UnicastAddress) ||
		desc.SessionInformation != nil || desc.URI != nil || desc.EmailAddress != nil || desc.PhoneNumber != nil || len(desc.Bandwidth) != 0 || len(desc.TimeZones) != 0 || desc.EncryptionKey != nil ||
		!validConnection(desc.ConnectionInformation) || len(desc.TimeDescriptions) != 1 || len(desc.MediaDescriptions) != 1 || len(desc.Attributes) > 1 {
		return ErrPolicy
	}
	timing := desc.TimeDescriptions[0]
	if timing.Timing.StartTime != 0 || timing.Timing.StopTime != 0 || len(timing.RepeatTimes) != 0 { return ErrPolicy }
	for _, a := range desc.Attributes {
		if a.Key != "control" || validateControl(a.Value, destination, true) != nil { return ErrPolicy }
	}
	m := desc.MediaDescriptions[0]
	if m == nil || m.MediaName.Media != "video" || m.MediaName.Port.Value < 0 || m.MediaName.Port.Value > 65535 || m.MediaName.Port.Range != nil ||
		len(m.MediaName.Protos) != 2 || m.MediaName.Protos[0] != "RTP" || m.MediaName.Protos[1] != "AVP" || len(m.MediaName.Formats) != 1 ||
		m.MediaTitle != nil || len(m.Bandwidth) != 0 || m.EncryptionKey != nil || !validConnection(m.ConnectionInformation) ||
		(desc.ConnectionInformation == nil && m.ConnectionInformation == nil) || len(m.Attributes) != 3 {
		return ErrPolicy
	}
	pt := m.MediaName.Formats[0]
	n, err := strconv.Atoi(pt)
	if err != nil || n < 96 || n > 127 || strconv.Itoa(n) != pt { return ErrPolicy }
	seen := make(map[string]bool, 3)
	for _, a := range m.Attributes {
		if seen[a.Key] || !validText(a.Value, 2048) { return ErrPolicy }
		seen[a.Key] = true
		switch a.Key {
		case "control":
			if validateControl(a.Value, destination, false) != nil { return ErrPolicy }
		case "rtpmap":
			if a.Value != pt+" H264/90000" { return ErrPolicy }
		case "fmtp":
			params, ok := strings.CutPrefix(a.Value, pt+" ")
			if !ok || !validFMTP(params) { return ErrPolicy }
		default:
			return ErrPolicy
		}
	}
	if !seen["control"] || !seen["rtpmap"] || !seen["fmtp"] { return ErrPolicy }
	return nil
}

func validFMTP(value string) bool {
	seen := make(map[string]bool, 2)
	for _, parameter := range strings.Split(value, ";") {
		key, val, ok := strings.Cut(strings.TrimSpace(parameter), "=")
		if !ok || seen[key] { return false }
		seen[key] = true
		switch key {
		case "packetization-mode":
			if val != "1" { return false }
		case "profile-level-id":
			if len(val) != 6 { return false }
			if _, err := hex.DecodeString(val); err != nil { return false }
		default:
			return false
		}
	}
	return seen["packetization-mode"]
}
