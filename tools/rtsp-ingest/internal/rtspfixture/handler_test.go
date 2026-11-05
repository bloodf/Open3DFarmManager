// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"testing"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/headers"
)

// Only pointer identity is used by these handlers: no library Start/Initialize,
// listener, transport, encoder or child process is created.
func fixtureForHandlers() *Fixture {
	return &Fixture{conn: &gortsplib.ServerConn{}, session: &gortsplib.ServerSession{}, stream: &gortsplib.ServerStream{}}
}

func TestFixtureHandlersAcceptCanonicalLibraryPath(t *testing.T) {
	u, err := base.ParseURL("rtsp://127.0.0.1:18554/fixture")
	if err != nil || u.Path != "/fixture" {
		t.Fatal("library URL lost its leading slash")
	}
	f := fixtureForHandlers()
	describe, stream, err := f.OnDescribe(&gortsplib.ServerHandlerOnDescribeCtx{
		Conn: f.conn, Request: &base.Request{Method: base.Describe, URL: u}, Path: u.Path,
	})
	if err != nil || describe.StatusCode != base.StatusOK || stream != f.stream {
		t.Fatal("canonical DESCRIBE did not return the owned stream")
	}
	contentBase := u.Clone()
	contentBase.Path += "/"
	track, err := (description.Media{Control: "trackID=0"}).URL(contentBase)
	if err != nil || track.Path != "/fixture/trackID=0" {
		t.Fatal("library control URL did not preserve canonical path")
	}
	// Audited v5 server_session.go getPathAndQueryAndTrackID preserves the
	// leading slash when passing the parent path to the SETUP handler.
	setup, stream, err := f.OnSetup(&gortsplib.ServerHandlerOnSetupCtx{
		Conn: f.conn, Session: f.session, Request: &base.Request{Method: base.Setup, URL: track}, Path: "/fixture",
		Transport: &gortsplib.SessionTransport{Protocol: gortsplib.ProtocolTCP, Profile: headers.TransportProfileAVP},
	})
	if err != nil || setup.StatusCode != base.StatusOK || stream != f.stream {
		t.Fatal("canonical TCP/AVP SETUP did not return the owned stream")
	}
	// v5 getPathAndQuery trims PLAY's trailing slash, retaining the leading one.
	play, err := f.OnPlay(&gortsplib.ServerHandlerOnPlayCtx{
		Conn: f.conn, Session: f.session, Request: &base.Request{Method: base.Play, URL: contentBase}, Path: "/fixture",
	})
	if err != nil || play.StatusCode != base.StatusOK || !f.playAccepted || f.Snapshot().Plays != 1 {
		t.Fatal("canonical PLAY was not admitted exactly once")
	}
}

func TestFixtureHandlersRejectNonCanonicalPathAndQuery(t *testing.T) {
	for _, tc := range []struct{ name, path, query string }{
		{"bare", "fixture", ""},
		{"foreign", "/other", ""},
		{"query", "/fixture", "unexpected=1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixtureForHandlers()
			response, stream, err := f.OnDescribe(&gortsplib.ServerHandlerOnDescribeCtx{
				Conn: f.conn, Path: tc.path, Query: tc.query,
			})
			if err != nil || response.StatusCode != base.StatusNotFound || stream != nil {
				t.Fatal("invalid DESCRIBE returned a stream")
			}
			response, stream, err = f.OnSetup(&gortsplib.ServerHandlerOnSetupCtx{
				Conn: f.conn, Session: f.session, Path: tc.path, Query: tc.query,
				Transport: &gortsplib.SessionTransport{Protocol: gortsplib.ProtocolTCP, Profile: headers.TransportProfileAVP},
			})
			if err != nil || response.StatusCode != base.StatusUnsupportedTransport || stream != nil {
				t.Fatal("invalid SETUP returned a stream")
			}
			response, err = f.OnPlay(&gortsplib.ServerHandlerOnPlayCtx{
				Conn: f.conn, Session: f.session, Path: tc.path, Query: tc.query,
			})
			if err != nil || response.StatusCode != base.StatusBadRequest || f.playAccepted || f.Snapshot().Plays != 0 {
				t.Fatal("invalid PLAY changed admission")
			}
		})
	}
}

func TestFixtureSetupRejectsUDPAndSAVP(t *testing.T) {
	for _, tc := range []struct {
		name     string
		protocol gortsplib.Protocol
		profile  headers.TransportProfile
	}{
		{"udp", gortsplib.ProtocolUDP, headers.TransportProfileAVP},
		{"multicast", gortsplib.ProtocolUDPMulticast, headers.TransportProfileAVP},
		{"savp", gortsplib.ProtocolTCP, headers.TransportProfileSAVP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixtureForHandlers()
			response, stream, err := f.OnSetup(&gortsplib.ServerHandlerOnSetupCtx{
				Conn: f.conn, Session: f.session, Path: "/fixture",
				Transport: &gortsplib.SessionTransport{Protocol: tc.protocol, Profile: tc.profile},
			})
			if err != nil || response.StatusCode != base.StatusUnsupportedTransport || stream != nil {
				t.Fatal("forbidden transport returned a stream")
			}
		})
	}
}
