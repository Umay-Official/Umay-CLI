# Umay API Gözlemleri

Umay CLI geliştirilirken Umay API'si ile yapılan denemelerde görülenler. Denemeler 7–9 Kasım 2026'da, Geliştirici & API Paneli'nden alınan ücretsiz bir anahtarla, Windows 11 üzerinde yapıldı. Amaç, Umay ekibine istemci tarafından görünen davranışı aktarmak.

## Özet

| Konu | Durum | Not |
| --- | --- | --- |
| Sohbet (`/v1/chat/completions`) | ✅ Çalışıyor | JSON ve akış (SSE) yanıtları sorunsuz |
| Modeller | ✅ | `umay-akilli`, `umay-hizli`; 9 Kasım'dan beri `umay-ultra-hizli`, `umay-daha-zeki` (belgelerde henüz yok) |
| Bilinmeyen model adı | ⚠️ Hata vermiyor | İstek sessizce `umay-akilli`'ye gidiyor |
| Yeni modellerin hızı | ⚠️ Çok yavaş | İlk token 10–120 sn; ~2 dakikada gelmezse akış boş kapanıyor |
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

## Yeni modeller: Ultra Hızlı ve Daha Zeki

9 Kasım 2026'da sitenin model menüsüne Umay Ultra Hızlı ve Umay Daha Zeki eklendi. Geliştirici panelindeki API örneklerinde hâlâ yalnızca `umay-akilli` ve `umay-hizli` yazıyor. Sitenin betiklerindeki adlar API'de denendi; yanıttaki `model` alanı sunucunun isteği hangi modele yönlendirdiğini gösteriyor:

| İstekteki model | Yanıttaki `model` |
| --- | --- |
| `umay-ultra-hizli`, `ultra-fast` | `umay-ultra-hizli` |
| `umay-daha-zeki`, `umay-zeki`, `smarter` | `umay-daha-zeki` |
| Bilinmeyen bir ad (ör. `umay-boyle-bir-model-yok`) | `umay-akilli` |

- Bilinmeyen model adı hata vermiyor, istek `200` ile Umay Akıllı'ya gidiyor; adı yanlış yazan istemci bunu fark edemiyor.
- `enable_thinking: true` ile iki yeni modelde de düşünceler `reasoning_content` alanında geliyor.
- Ultra Hızlı düşünme kapalıyken (`enable_thinking: false`) İngilizce iç sesini cevabın içine yazdı ("Actually, I'll output the correct official list…") ve istenen listeyi yarım bıraktı.

Hız, 9 Kasım 03:30–03:45 arasında art arda gönderilen tek tek isteklerle ölçüldü:

| | Umay Akıllı | Umay Hızlı | Umay Ultra Hızlı | Umay Daha Zeki |
| --- | --- | --- | --- | --- |
| Kısa yanıt ("tamam", akışsız, düşünme kapalı) | 0,9 sn | 1,5 sn | 10–25 sn | 63–81 sn |
| Akışta ilk token (81 il listesi, düşünme kapalı) | 3,4 sn | yanıt boş geldi | 31 sn; bir denemede boş | 44–120 sn; bir denemede boş |
| Akış hızı | 233 karakter/sn | – | 246 karakter/sn | 49–55 karakter/sn |
| Düşünme açıkken ilk düşünce | 1,3 sn | 0,8 sn | 0,6–4,1 sn | 40–49 sn |

- **Boş akış:** İlk token yaklaşık 2 dakika içinde gelmezse sunucu bağlantıyı `200` ile, hiç `data:` olayı ve `finish_reason` göndermeden kapatıyor (iki denemede de 125 sn). İstemci bunu modelin boş cevabından ayıramıyor.
- **Arka uca ulaşılamadığında:** 9 Kasım 04:25 civarında Daha Zeki'ye giden her istek yaklaşık 1 dakika sonra akış içinde bir hata olayıyla bitti: "Tüm API anahtarları denendi fakat yanıt alınamadı". Mesajda arka uçtaki sağlayıcının adresi ve ondan gelen `HTTP 429 Too Many Requests` de yer alıyor.
- **Uzun yanıtlarda kesilme:** Sunucu her isteği yaklaşık 180 saniyede kesiyor; çıktı akmaya devam etse bile akış "context deadline exceeded (Client.Timeout or context cancellation while reading body)" hatasıyla bitiyor. 9 Kasım sabahki benchmark'ta Ultra Hızlı düşünme açıkken 14 sıfırın 10'u bundan geldi: model cevaba ya da araç çağrısına geçmeden önce 3 dakikadan uzun düşündü.
- **Daha Zeki'nin değişmesi:** 9 Kasım 16:50 civarında Daha Zeki'nin davranışı değişti: zaman aşımı mesajı "Yapay zeka motoru yanıt süresi aşıldı (Zaman aşımı)" oldu ve yanıtlar 40–120 saniye yerine birkaç saniyede gelmeye başladı. İlk yarım saatte cevapların başında İngilizce bir "thought" bloğu görüldü; akşamki koşuda bu tekrarlanmadı. Ultra Hızlı da aynı gün sabahtan akşama değişti: düşünme kapalıyken araç kullanılmayan görevlerde ortalama süre 238 saniyeden 9 saniyeye indi ve cevapları Daha Zeki'ninkilerle aynılaştı. Aynı model adının arkasındaki model değişirse önceki ölçümler geçerliliğini yitirir.
- **Araç çağrılarının sonu:** Umay modelleri API'de yerleşik araç çağrısı yerine metin içinde `<tool_call>` blokları yazıyor. Uzun bir dosya ya da kod argümanından sonra JSON'un sonu sık sık bozuluyor: eksik `}`, `}` yerine `)` ya da `]`, sonda fazladan `"}}`. Umay CLI bu kapanışları onarıyor (yalnızca sondaki birkaç karakteri; ortası bozuk çağrıyı reddediyor). Daha Zeki onarım öncesinde dosya yazılmadığı hâlde "dosya oluşturuldu" dedi.
- **Argümanların yeri:** Modeller, en çok da Umay Hızlı, argümanları sık sık `arguments` nesnesinin dışına yazıyor: tek zorunlu argümanı düz metin olarak (`"arguments": "README.md"`), diğerlerini `arguments` ile yan yana (`"arguments": {...}, "timeout": 60`) ya da erken kapatıp yeni bir nesnede (`{"path": "a.py"},{"max_lines": 200}`). 9–10 Kasım koşularında ham metni saklanan 131 okunamayan çağrının 49'u böyleydi; Umay CLI artık aracın şemasına bakarak bunları yerine koyuyor. Kalan 82 çağrının çoğunda kod içindeki tırnaklar kaçışsız yazılmış; bunlar tahmin edilmiyor, modele hata olarak dönüyor.

**Öneri:** Yeni model adlarının ve `/v1/models` listesinin belgelere eklenmesi; bilinmeyen model adına `404` ya da `400`; zaman aşımında akışa bir hata olayı (ya da `504`) gönderilmesi ve 180 saniyelik sınırın belgelenmesi ya da uzatılması; model adının arkasındaki model değiştiğinde duyurulması; API'de yerleşik araç çağrısı (`tools`); arka uç geçici olarak yanıt vermiyorsa `503` ve `Retry-After`; hata mesajlarında iç sağlayıcı ayrıntılarının istemciye gönderilmemesi.

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

9–10 Kasım 2026 gecesi dört model, Umay CLI ile Gambit Bench v2'nin 39 görevinde süre sınırı olmadan koşturuldu. Umay Akıllı düşünme açıkken **89,4** aldı (zor görevlerde 89,1), 22 görev tam puan, toplam 47 dakika; aynı görevlerde en iyi yerel model Qwen3.8 27B 84,3 almıştı (toplam 872 dakika). Akıllı düşünme açık kategorileri: hata ayıklama 100, terminal 98, talimat 97, mantık 96, kod yazma 95, kod inceleme 90, SQL 87, kod okuma 85, ajan 66. Grafik ve koşullar: [KIYASLAMA.md](KIYASLAMA.md).

Aynı gece Akıllı otomatikte 72,1 ve kapalıyla 67,5; Hızlı açıkla 87,2, kapalıyla 73,9 ve otomatikte 64,9; Daha Zeki açıkla 71,3 ve kapalıyla 52,4; Ultra Hızlı açıkla 61,7 ve kapalıyla 42,3 aldı.

- **Otomatik mod değişti:** 8 Kasım'da alan gönderilmediğinde Umay düşünüyordu (araçsız görevlerde görev başına medyan Akıllı'da ~4.000, Hızlı'da ~9.400 karakter düşünce). 9–10 Kasım gecesi alan gönderilmediğinde hiç düşünce gelmedi ve puanlar kapalıya yaklaştı (Akıllı 83,2 → 72,1, Hızlı 79,4 → 64,9). Alan gönderilmediğinde ne olacağı belgelenmediği için bu değişiklik istemciden fark edilemiyor.
- **`enable_thinking: false` uyuluyor:** Dört modelde de `false` gönderildiğinde hiçbir yanıtta düşünce gelmedi; `true` gönderildiğinde her yanıtta geldi.
- **Ultra Hızlı ve Daha Zeki:** Akşamki koşuda araç kullanılmayan görevlerde düşünme kapalıyken neredeyse aynı cevapları verdiler; iki adın arkasında aynı model var gibi görünüyor. Ultra Hızlı sabah düşünme kapalıyken 73,7 almıştı.
- **Sunucu hataları:** Akıllı'ya giden istekler gece yaklaşık 80 dakika boyunca "Yapay zeka servisleri şu anda yanıt veremiyor" hatasıyla döndü; Hızlı'da iki yanıt 180. saniyede aynı hatayla kesildi.

**Yanıt uzunluk sınırı (8 Kasım):** O günkü koşulardaki 13 sıfırın hepsinde yanıt cevaba ya da araç çağrısına gelmeden kesildi. Umay Hızlı'da yanıt her seferinde yaklaşık 26–33 bin karakterde (yaklaşık 8 bin token), Umay Akıllı'da 9–13 bin karakterde bitti. Hızlı, düşünme açıkken ve alan gönderilmediğinde cevaptan önce uzun plan yazıyor; bu yüzden uzun kod isteyen görevlerde hiç cevap veremedi. `enable_thinking: false` ile 78 görevde hiç kesilme olmadı. Kesilen yanıtlarda `finish_reason` `length` değildi, yani istemci yanıtın kesildiğini anlayamıyor. **Öneri:** Yanıt sınırının belgelenmesi ya da düşünce için ayrı bir bütçe ayrılması, kesilen yanıtlarda `finish_reason: "length"` dönmesi ve alan gönderilmediğinde düşünmenin açık mı kapalı mı olduğunun belgelenmesi.

9–10 Kasım gecesi bu kesilme yalnızca bir kez görüldü (Daha Zeki, bir talimat görevi). 8 Kasım'da Akıllı'nın düşünme açıkken aldığı tek sıfır, 9 kurallı bir metin görevinde modelin kuralları uzun uzun hesaplarken yanıt uzunluk sınırına ulaşması ve cevap yazamamasıydı (yanıt yalnızca düşünceden oluştu). Düşünme modunda yanıt bütçesinin ne kadarının düşünceye ayrılabileceği belgelenirse istemciler buna göre davranabilir.

## Site ile API arasındaki fark

Sitedeki `/derin-arastirma` (Vuhuv web araması), `/yt-özetle`, `/mail`, belge üretimi ve bellek sitenin kendi uç noktalarında (`/api/chat/...`, `/api/integrations/gmail/...`, `/api/memory/...`) ve site oturumuyla çalışıyor; API anahtarıyla erişilemiyor. CLI belge üretimini yerelde yapabildi. Web araması, YouTube, Gmail ve bellek için API karşılığı yok.

Site 8 Kasım 2026'dan sonra güncellendi (betik sürümü 29 → 34): arka plan nöbetçileri (`/nobetci`, `/nobetci-sil`, `/takip` ve `/api/guards/...`) kaldırıldı; bellek (`/api/memory/...`), "Krallıklar & Liderlik" (`/api/leaderboards`) ve sohbet isteğine dil alanı (`language`) eklendi. Geliştirici panelindeki API örnekleri değişmedi.

**Öneri:** Web araması için bir API seçeneği (örneğin istekte bir bayrak) eklenirse, istemciler de güncel bilgiyle yanıt verebilir.
