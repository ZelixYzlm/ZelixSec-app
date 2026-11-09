# ZelixSec 🛡️

**Tek tuşla DPI atlatan yerel ağ geçidi** — TLS ClientHello parçalama + DNS-over-HTTPS.

> ZelixYzlm — Emir Özer

## Özellikler (v1.0.2)

- **DPI atlatma** — TLS ClientHello parçalama (split/split2 modları), Discord/Roblox/Sosyal profil seçimleri
- **Reklam engelleyici** — motor içinde çalışır; Reklam sekmesinde istatistikler + özel engel listesi
- **Uygulama içi güncelleme** — her açılışta otomatik kontrol; yeni sürüm bulunursa kurulum dosyası indirilir ve sessiz (/S) kurulur
- **23 dil** — Türkçe (varsayılan), İngilizce, Rusça + 20 Avrupa dili
- **9 sekmeli ayarlar** — Genel, Motor, DNS, Reklam, Güncelleme, Test, Nasıl Çalışır, Hakkında
- **12 renk teması** + şeffaflık kaydırıcısı + aurora arka planı

## Kurulum

`ZelixSec-Setup-x.y.z.exe` dosyasını indirip çalıştırın. Uygulama bundan sonra
kendi güncellemelerini **Ayarlar → Güncelleme** üzerinden otomatik yönetir.

## Güncelleme yayınlama (geliştirici)

1. Yeni sürümü paketleyin: `ZelixSec-Setup-<sürüm>.exe`
2. GitHub Releases'e bir sürüm oluşturup kurulum dosyasını asset olarak yükleyin
3. Bu repodaki `update.json` dosyasını güncelleyin:

```json
{
  "latest": "1.0.3",
  "notes": "Yenilikler…",
  "url": "https://github.com/ZelixYzlm/ZelixSec-app/releases/download/v1.0.3/ZelixSec-Setup-1.0.3.exe",
  "publishedAt": "2026-12-01"
}
```

  - `latest` — yeni sürüm numarası (zorunlu)
  - `url` — kurulum dosyasının **doğrudan** bağlantısı (yeni sürüm varken kullanılır)
  - `sha256` — opsiyonel; dosya bütünlüğü kontrolü
  - `publishedAt` — opsiyonel; yayın tarihi

Müşteriler bir sonraki açılışta güncellemeyi otomatik fark eder.

## Kaynak kodu

`electron/` • `engine/` • `renderer/` • `assets/` dizinleri uygulamanın kaynak kodunu içerir.

## Lisans

MIT
