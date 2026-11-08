# Umay API Gözlemleri

Umay CLI geliştirilirken Umay API'si ile yapılan denemelerde görülenler. Denemeler 7–8 Kasım 2026'da, Geliştirici & API Paneli'nden alınan ücretsiz bir anahtarla, Windows 11 üzerinde yapıldı. Amaç, Umay ekibine istemci tarafından görünen davranışı aktarmak.

## Özet

| Konu | Durum | Not |
| --- | --- | --- |
| Sohbet (`/v1/chat/completions`) | ✅ Çalışıyor | JSON ve akış (SSE) yanıtları sorunsuz |
| Modeller | ✅ | `umay-akilli`, `umay-hizli` |
| Düşünme modu | ✅ Çalışıyor | `enable_thinking` ile `reasoning_content` geliyor |
| Yerleşik araç çağrısı (`tools`) | ❌ Kullanılmıyor | Model `tool_calls` döndürmüyor; CLI metin protokolüyle çözdü |
| Görseller | ❌ İşlenmiyor | İstek hata vermiyor ama model görseli görmüyor |
| Yapılandırılmış çıktı (JSON, Markdown) | ✅ Güvenilir | Belge komutları çoğunlukla ilk denemede doğru biçimde |

## Uç nokta ve kimlik doğrulama

- `POST https://umayzeka.com/v1/chat/completions`, `Authorization: Bearer umay-sk-...`
- Anahtarsız istek `401` ve JSON gövde döndürür; mesaj `umay-sk-...` biçimini belirtir. Yönlendirme veya HTML sayfası dönmez; bu, istemcide anlaşılır hata göstermeyi kolaylaştırıyor.
- Panelde hesap başına günlük 130.000 istek (RPD) ve dakikada 100 istek (RPM) sınırı görünüyor. Denemeler boyunca sınıra yaklaşılmadı.

## Yerleşik araç çağrısı

İstekte OpenAI biçiminde `tools` dizisi (yedi araç, JSON şemalarıyla) gönderildi. Yanıtta `tool_calls` hiç gelmedi. Model araçları düz metin olarak, şemadaki adlar yerine tahmin ettiği adlarla yazdı:

```text
<tool_call>
##
list_files(path=".")
<tool_call>
##
read_file(path="test.txt")
```

Şemada araç adı `list_dir` idi. Bu, `tools` alanının modele iletilmediğini düşündürüyor; model bir araç biçimi biliyor ama hangi araçların var olduğunu görmüyor.

**İstemcideki çözüm:** Araç listesi ve sabit bir çağrı biçimi sistem mesajıyla modele anlatılıyor. Model `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` yazıyor, CLI bu blokları ayrıştırıp çalıştırıyor ve sonuçları sonraki mesajda geri gönderiyor. Bu yöntemle yedi aracın tamamı (dosya listeleme, okuma, arama, yazma, düzenleme, PowerShell, Python) gerçek anahtarla doğru çalıştı. Model ara sıra JSON içine kaçışsız satır sonu koyuyor; istemci bunu tolere ediyor.

**Öneri:** `tools` alanı modele iletilir ve yanıtta standart `tool_calls` dönerse, OpenAI uyumlu ajan kütüphaneleri (AI SDK, LangChain, OpenAI SDK) Umay ile doğrudan araç kullanabilir. CLI bu durumda `--tool-mode native` ile yerleşik moda geçebiliyor.

## Düşünme modu

Site kendi sunucusuna `enable_thinking` gönderiyor. CLI, düşünme açıkken API isteğine hem `enable_thinking: true` hem de `chat_template_kwargs: {"enable_thinking": true}` ekledi. Sonuç:

- Düşünceler akışta `reasoning_content` alanında geldi, yanıt metninden ayrı. İki alandan hangisinin etkili olduğu ayrıca denenmedi.
- Düşünme kapalıyken (ek alan gönderilmeden) düşünce gelmedi.
- Düşünceler İngilizce, yanıtlar Türkçe geliyor.

**Öneri:** Hangi alanın desteklendiği API belgelerinde yazarsa istemciler doğru alanı gönderebilir. Düşüncelerin de Türkçe olması Türkçe kullanıcılar için daha anlaşılır olur.

## Görseller

Bir `.jpg` görsel, OpenAI biçiminde görsel parçası olarak (`image_url`, base64 veri adresi) gönderildi. İstek `200` döndü ama model görseli görmedi; önceki konuşmadaki bir şemayı anlatmaya başladı. Sonraki denemede görseli tanıyamadığını kendisi söyledi.

**Öneri:** Görsel desteği API'de yoksa, isteği `400` ve açıklayıcı bir mesajla reddetmek istemcilerin durumu kullanıcıya doğru anlatmasını sağlar. Destek eklenirse CLI'de `UMAY_IMAGES=1` ile açılabilir.

## Yapılandırılmış çıktı ve süreler

Belge komutları modelden JSON, Markdown, Mermaid veya `DOSYA:` blokları ister; dosyalar istemcide oluşturulur.

| Komut | Model çıktısı | Süre | Sonuç |
| --- | --- | --- | --- |
| `/sunum` (10 slayt) | JSON | 21 sn | İlk denemede doğru |
| `/rapor` | JSON | 7 sn | İlk denemede doğru |
| `/sema` | Mermaid | 21 sn | İlk denemede doğru |
| `/dokuman` (dilekçe) | Markdown | 50 sn | Doğru; tarih bir gün eksikti, istemci artık tarihi isteğe ekliyor |
| `/proje` (3 dosya, 233 satır) | `DOSYA:` blokları | 29 sn | Düşünme kapalıyken ilk denemede doğru |
| `/konsey` | Markdown, 4 istek | 68 sn | Doğru |

`/proje` ilk denemede, düşünme modu açıkken iki kez beklenen biçimi vermedi. Ham yanıt o sırada kaydedilmediği için neden görülemedi; olası neden, uzun düşüncenin yanıt sınırını doldurması. Düşünme kapatılınca sorun tekrarlanmadı.

**Öneri:** Yanıt uzunluk sınırı ve `max_tokens` üst değeri belgelerde yazarsa istemciler uzun çıktıları buna göre bölebilir.

## Site ile API arasındaki fark

Sitedeki `/derin-arastirma` (Vuhuv web araması), `/yt-özetle`, `/mail`, `/nobetci` ve belge üretimi sitenin kendi uç noktalarında (`/api/chat/...`, `/api/guards/...`) ve site oturumuyla çalışıyor; API anahtarıyla erişilemiyor. CLI belge üretimini yerelde yapabildi. Web araması, YouTube ve Gmail için API karşılığı yok.

**Öneri:** Web araması için bir API seçeneği (örneğin istekte bir bayrak) eklenirse, istemciler de güncel bilgiyle yanıt verebilir.
