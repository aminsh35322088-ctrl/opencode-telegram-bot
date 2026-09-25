package main

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

const (
	targetHost = "100.81.141.68"
	targetPort = "22"
	localAddr  = "127.0.0.1:2222"
	stateDir   = "/data/tsnet"
	hostname   = "opencode-telegram-bot-railway"
)

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

	targetAddr := net.JoinHostPort(targetHost, targetPort)

	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		log.Fatalf("[tsnet] create state dir: %v", err)
	}

	srv := &tsnet.Server{
		Dir:       stateDir,
		Hostname:  hostname,
		AuthKey:   authKey,
		Ephemeral: false,
	}
	if err := srv.Start(); err != nil {
		log.Fatalf("[tsnet] start failed: %v", err)
	}
	defer srv.Close()

	log.Printf("[tsnet] node started hostname=%s ephemeral=false", hostname)

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
