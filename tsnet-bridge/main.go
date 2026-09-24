package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		log.Fatalf("[tsnet] invalid %s=%q: %v", key, raw, err)
	}
	return value
}

func validateLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", addr, err)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("refusing non-loopback listen address %q; set TSNET_ALLOW_NON_LOOPBACK=true only if intentional", addr)
	}
	return nil
}

func proxyConnection(srv *tsnet.Server, local net.Conn, target string) {
	defer local.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	remote, err := srv.Dial(ctx, "tcp", target)
	if err != nil {
		log.Printf("[tsnet] dial failed target=%s remote=%s error=%v", target, local.RemoteAddr(), err)
		return
	}
	defer remote.Close()

	log.Printf("[tsnet] forwarding local=%s target=%s", local.RemoteAddr(), target)

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remote, local)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(local, remote)
		done <- struct{}{}
	}()

	<-done
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	authKey := strings.TrimSpace(os.Getenv("TS_AUTHKEY"))
	if authKey == "" {
		log.Fatal("[tsnet] TS_AUTHKEY is required")
	}

	targetHost := strings.TrimSpace(os.Getenv("TSNET_TARGET"))
	if targetHost == "" {
		log.Fatal("[tsnet] TSNET_TARGET is required")
	}

	targetPort := envOr("TSNET_TARGET_PORT", "22")
	targetAddr := net.JoinHostPort(targetHost, targetPort)
	localAddr := envOr("TSNET_LOCAL_ADDR", "127.0.0.1:2222")

	if !envBool("TSNET_ALLOW_NON_LOOPBACK", false) {
		if err := validateLoopback(localAddr); err != nil {
			log.Fatal("[tsnet] ", err)
		}
	}

	stateDir := envOr("TSNET_STATE_DIR", "/tmp/opencode-tsnet")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		log.Fatalf("[tsnet] create state dir: %v", err)
	}

	srv := &tsnet.Server{
		Dir:       stateDir,
		Hostname:  envOr("TSNET_HOSTNAME", "opencode-telegram-bot-railway"),
		AuthKey:   authKey,
		Ephemeral: envBool("TSNET_EPHEMERAL", true),
	}
	if err := srv.Start(); err != nil {
		log.Fatalf("[tsnet] start failed: %v", err)
	}
	defer srv.Close()

	log.Printf("[tsnet] node started hostname=%s ephemeral=%t", srv.Hostname, srv.Ephemeral)

	probeCtx, probeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	probeConn, err := srv.Dial(probeCtx, "tcp", targetAddr)
	probeCancel()
	if err != nil {
		log.Printf("[tsnet] startup probe failed target=%s error=%v", targetAddr, err)
	} else {
		_ = probeConn.Close()
		log.Printf("[tsnet] startup probe OK target=%s", targetAddr)
	}

	listener, err := net.Listen("tcp", localAddr)
	if err != nil {
		log.Fatalf("[tsnet] local listener failed addr=%s error=%v", localAddr, err)
	}
	defer listener.Close()

	log.Printf("[tsnet] local forward ready listen=%s -> %s", localAddr, targetAddr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("[tsnet] accept failed: %v", err)
			continue
		}
		go proxyConnection(srv, conn, targetAddr)
	}
}
