# LA plan

Hesap gerektirmeyen ortak tatil planı. Aile katalogdaki seçenekleri işaretler, her kartın altına yorum
bırakır; link kimde varsa aynı planı görür ve değiştirir. Her planın kendi gizli linki ve kendi verisi var.

## Nasıl çalışır

- **Sayfa:** düz HTML + ES modülleri, derleme yok. GitHub Pages'te yayınlanır.
- **Ortak veri:** Supabase (ücretsiz plan). Tabloların tarayıcıya hiçbir yetkisi yok; içeri giriş yalnızca
  beş fonksiyondan (`plan_get`, `answer_set`, `comment_add`, `comment_delete`, `plan_ping`). Her fonksiyon
  planın gizli anahtarını ister. Veritabanı anahtarın yalnızca SHA-256 özetini tutar.
- **Link:** `https://okavak.github.io/la-plan/#k=<anahtar>`. Anahtar `#` ile başladığı için sunuculara gitmez.
- **Eşitleme:** her dokunuş soru başına yazılır, sayfa 5 saniyede bir yoklar. Bağlantı yokken yazılanlar
  cihazda saklanır, bağlantı gelince gönderilir.
- Link olmadan açılan sayfa yalnızca bu cihazda çalışır (paylaşımsız).

## Plan ekleme ve yönetim

Ayarlar `~/.config/la-plan/env` dosyasında (`LA_PROJECT_REF`, `LA_SUPABASE_URL`, `LA_SUPABASE_ANON_KEY`),
SQL `supabase db query` ile çalışır (önce `supabase login`).

```sh
node tools/admin.mjs new-plan plan-a "Plan başlığı" "Altyazı"   # linki yazdırır, .local/urls.txt'e ekler
node tools/admin.mjs rotate-key plan-a                           # link sızdıysa yeni link üretir
node tools/admin.mjs set-plan-doc plan-a plan.json               # gün gün plan belgesini yazar
node tools/admin.mjs delete-plan plan-a
```

## Geliştirme ve testler

```sh
npm test                    # çevrimdışı birim testleri (PGlite ile SQL dahil)
npm run test:contract       # beş fonksiyonun sözleşme testi, bellek içi sahte sunucuya karşı
npm run test:remote         # aynı testler gerçek Supabase projesine karşı

node tools/fake-backend.mjs 8787                          # sahte sunucu
node tools/serve.mjs 8124 http://127.0.0.1:8787           # sayfayı sahte sunucuya bağlı sunar
```

## Yayın

`./deploy.sh` testleri çalıştırır ve `main`'i GitHub'a gönderir. İlk çalıştırmada depoyu ve Pages'i açar.

## Notlar

- Depo public; içinde isim, konaklama ya da aile bilgisi yok. Plana özel başlık ve altyazı yalnızca
  veritabanında durur, katalog herkese açık yerlerden oluşur.
- Supabase ücretsiz projeleri bir hafta hiç kullanılmazsa uyur. Haftalık uyandırma için GitHub'da `workflow`
  yetkisi gerekir; yetki yokken sayfa "Bağlantı yok" der ve proje Supabase panelinden tek tıkla uyandırılır.
- Fotoğraflar Wikimedia Commons'tan, serbest lisanslı; sayfanın altında sanatçı ve lisans yazıyor.
