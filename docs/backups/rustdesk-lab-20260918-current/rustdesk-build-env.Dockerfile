FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ca-certificates clang cmake curl gcc g++ git make perl pkg-config libclang-dev llvm-dev nasm \
    libasound2-dev libunwind-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libgtk-3-dev libpulse-dev libva-dev libvdpau-dev libxcb-randr0-dev \
    libxcb-shape0-dev libxcb-xfixes0-dev libxdo-dev libxfixes-dev libdbus-1-dev libssl-dev \
    libyuv-dev libvpx-dev libopus-dev libaom-dev \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/rustdesk-pkgconfig && cat > /opt/rustdesk-pkgconfig/libyuv.pc <<'PC'
prefix=/usr
exec_prefix=${prefix}
libdir=/usr/lib/x86_64-linux-gnu
includedir=/usr/include

Name: libyuv
Description: YUV conversion library
Version: 0
Libs: -L${libdir} -lyuv
Cflags: -I${includedir}
PC
ENV PKG_CONFIG_PATH=/opt/rustdesk-pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig