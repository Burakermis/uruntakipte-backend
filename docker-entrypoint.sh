#!/bin/sh
# Sanal ekranı (Xvfb) başlatıp asıl komutu çalıştırır. DISPLAY dışarıdan
# verilmişse (gerçek bir ekran) dokunmaz.
set -e

if [ -z "$DISPLAY" ]; then
  # Konteyner yeniden başlarsa eski kilit dosyası kalır ve Xvfb açılmaz.
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
  # Ekranın soketi görünene kadar (en fazla ~5sn) bekle.
  i=0
  while [ ! -e /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
fi

# exec: komut PID 1 olur ve SIGTERM'i (zarif kapanış) doğrudan alır.
exec "$@"
