# Umay API Gözlemleri

Umay CLI geliştirilirken Umay API'si ile yapılan denemelerde görülenler. Denemeler 7–8 Kasım 2026'da, Geliştirici & API Paneli'nden alınan ücretsiz bir anahtarla, Windows 11 üzerinde yapıldı. Amaç, Umay ekibine istemci tarafından görünen davranışı aktarmak.

## Özet

| Konu | Durum | Not |
| --- | --- | --- |
| Sohbet (`/v1/chat/completions`) | ✅ Çalışıyor | JSON ve akış (SSE) yanıtları sorunsuz |
| Modeller | ✅ | `umay-akilli`, `umay-hizli` |
| Düşünme modu | ✅ Çalışıyor | `enable_thinking` ile `reasoning_content` geliyor |
| Yerleşik araç çağrısı (`tools`) | ❌ Kullanılmıyor | Model `tool_calls` döndürmüyor; CLI metin protokolüyle çözdü |
| Görseller | ❌ İşlenmiyor | İstek hata vermiyor ama Akıllı da Hızlı da görseli görmüyor |
| Yapılandırılmış çıktı (JSON, Markdown) | ✅ Güvenilir | Belge komutları çoğunlukla ilk denemede doğru biçimde |

## Uç nokta ve kimlik doğrulama

- `POST https://umayzeka.com/v1/chat/completions`, `Authorization: Bearer umay-sk-...`
- Anahtarsız istek `401` ve JSON gövde döndürür; mesaj `umay-sk-...` biçimini belirtir. Yönlendirme veya HTML sayfası dönmez; bu, istemcide anlaşılır hata göstermeyi kolaylaştırıyor.
- Panelde hesap başına günlük 130.000 istek (RPD) ve dakikada 100 istek (RPM) sınırı görünüyor. Denemeler boyunca sınıra yaklaşılmadı.

- Bir test kullanıcısı uzun bir ajan oturumunda `HTTP 522` aldı (Cloudflare, Umay'ın asıl sunucusuna zamanında ulaşamadı; yanıt HTML). CLI artık 502, 504 ve 520–524 yanıtlarında isteği 2 saniye sonra bir kez tekrarlıyor ve sorunu "Umay tarafında geçici" olarak bildiriyor.

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

Site kendi sunucusuna `enable_thinking` gönderiyor. CLI, düşünme açıkken API isteğine hem `enable_thinking: true` hem de `chat_template_kwargs: {"enable_thinking": true}` ekledi; kapalıyken ilk koşularda hiçbir alan göndermedi, sonra aynı alanları `false` olarak göndermeye başladı. Sonuç:

- Düşünceler akışta `reasoning_content` alanında geldi, yanıt metninden ayrı. İki alandan hangisinin etkili olduğu ayrıca denenmedi.
- Alan gönderilmediğinde Umay kendi karar veriyor: kısa sohbette düşünce gelmedi, ama benchmark'ta uzun görevlerde düşündüğü görüldü (sonuçlar "açık"a yakın, uzun planlar ve kesilmeler aynı).
- `enable_thinking: false` düşünceyi gerçekten kapatıyor: kesilmeler bitti, ama benchmark puanı Akıllı'da 22, Hızlı'da 13 puan düştü.
- Düşünceler İngilizce, yanıtlar Türkçe geliyor.

**Öneri:** Hangi alanın desteklendiği API belgelerinde yazarsa istemciler doğru alanı gönderebilir. Düşüncelerin de Türkçe olması Türkçe kullanıcılar için daha anlaşılır olur.

## Görseller

Bir `.jpg` görsel, OpenAI biçiminde görsel parçası olarak (`image_url`, base64 veri adresi) gönderildi. İstek `200` döndü ama model görseli görmedi; önceki konuşmadaki bir şemayı anlatmaya başladı. Sonraki denemede görseli tanıyamadığını kendisi söyledi.

Site güncellemesinden sonra (tanıtımda artık "görsel/video algılama" yazıyor) aynı gün tekrar denendi: üzerinde "KARPUZ 4817" yazan, yeşil daire ve sarı üçgen içeren bir PNG, yeni sohbetlerde önce Umay Akıllı'ya, sonra Umay Hızlı'ya gönderildi. İki model de görseli görmediğini söyledi ("Mesajınızda herhangi bir görsel eklenmemiş", "Görseli paylaşmamışsınız"). Giden isteğin görseli standart biçimde (`image_url`, `data:image/png;base64,...`) taşıdığı istemci tarafında doğrulandı; yani görsel API'de iki modele de ulaşmıyor; sitedeki görsel desteği yalnızca sitenin kendi yükleme uç noktası (`/api/chat/upload`) üzerinden çalışıyor gibi görünüyor.

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

## Token kullanımı ve bağlam uzunluğu

- `GET https://umayzeka.com/v1/models` bir model listesi yerine sitenin ana sayfasını (HTML) döndürüyor; modellerin bağlam uzunluğu API'den öğrenilemiyor ve belgelerde de yazmıyor.
- Akışlı yanıtlarda token sayısı gelmesi için CLI istekte `stream_options: {"include_usage": true}` gönderiyor (sunucu bu alanı reddederse oturumun geri kalanında göndermiyor). 8 Kasım 2026'daki denemede istek hatasız yanıtlandı ama akışta kullanım bilgisi (`usage`) gelmedi. Akışsız istekte `usage` geldi (ör. 42 çıktı token), ancak sistem mesajı ve önceki konuşma da gönderildiği hâlde `prompt_tokens` yalnızca son kullanıcı mesajını sayıyordu (3 token). Bu yüzden CLI bağlam boyutunu göstermiyor; token/sn de yalnızca akışta doğru ölçülebildiği için şu an görünmüyor.

**Öneri:** `/v1/models` uç noktası (model adları ve `context_length` ile), akışta `usage` desteği ve tüm isteği sayan `prompt_tokens`, istemcilerin bağlam doluluğunu ve hızı göstermesini sağlar.

## Benchmark

8 Kasım 2026'da Umay Akıllı (düşünme açık), Umay CLI ile Gambit Bench v2'nin 39 görevinde koşturuldu: genel puan **87,6** (zor görevlerde 86,5), 21 görev tam puan, toplam 45 dakika. Aynı görevlerde en iyi yerel model Qwen3.8 27B, süre sınırı olmadan 84,3 almıştı (toplam 872 dakika). Akıllı düşünme açık kategorileri: hata ayıklama 100, mantık 96, terminal 95, ajan 90, kod okuma 90, SQL 87, kod yazma 85, kod inceleme 77, talimat 51. Grafik ve koşullar: [KIYASLAMA.md](KIYASLAMA.md).

Aynı gün Akıllı alan gönderilmeden (otomatik) 83,2 ve `enable_thinking: false` ile 65,2; Hızlı düşünme açıkla 81,4, otomatikte 79,4 ve kapalıyla 68,7 aldı.

**Yanıt uzunluk sınırı:** Bu koşulardaki 13 sıfırın hepsinde yanıt cevaba ya da araç çağrısına gelmeden kesildi. Umay Hızlı'da yanıt her seferinde yaklaşık 26–33 bin karakterde (yaklaşık 8 bin token), Umay Akıllı'da 9–13 bin karakterde bitti. Hızlı, düşünme açıkken ve alan gönderilmediğinde cevaptan önce uzun plan yazıyor; bu yüzden uzun kod isteyen görevlerde hiç cevap veremedi. `enable_thinking: false` ile 78 görevde hiç kesilme olmadı. Kesilen yanıtlarda `finish_reason` `length` değildi, yani istemci yanıtın kesildiğini anlayamıyor. **Öneri:** Yanıt sınırının belgelenmesi ya da düşünce için ayrı bir bütçe ayrılması, kesilen yanıtlarda `finish_reason: "length"` dönmesi ve alan gönderilmediğinde düşünmenin açık mı kapalı mı olduğunun belgelenmesi.

Akıllı'nın düşünme açıkken aldığı tek sıfır, 9 kurallı bir metin görevinde modelin kuralları uzun uzun hesaplarken yanıt uzunluk sınırına ulaşması ve cevap yazamamasıydı (yanıt yalnızca düşünceden oluştu). Düşünme modunda yanıt bütçesinin ne kadarının düşünceye ayrılabileceği belgelenirse istemciler buna göre davranabilir.

## Site ile API arasındaki fark

Sitedeki `/derin-arastirma` (Vuhuv web araması), `/yt-özetle`, `/mail`, belge üretimi ve bellek sitenin kendi uç noktalarında (`/api/chat/...`, `/api/integrations/gmail/...`, `/api/memory/...`) ve site oturumuyla çalışıyor; API anahtarıyla erişilemiyor. CLI belge üretimini yerelde yapabildi. Web araması, YouTube, Gmail ve bellek için API karşılığı yok.

Site 8 Kasım 2026'dan sonra güncellendi (betik sürümü 29 → 34): arka plan nöbetçileri (`/nobetci`, `/nobetci-sil`, `/takip` ve `/api/guards/...`) kaldırıldı; bellek (`/api/memory/...`), "Krallıklar & Liderlik" (`/api/leaderboards`) ve sohbet isteğine dil alanı (`language`) eklendi. Geliştirici panelindeki API örnekleri değişmedi.

**Öneri:** Web araması için bir API seçeneği (örneğin istekte bir bayrak) eklenirse, istemciler de güncel bilgiyle yanıt verebilir.
