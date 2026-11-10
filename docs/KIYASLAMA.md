# Kıyaslama: Gambit Bench v2

Umay'ın dört modeli [Umay CLI](../README.md) üzerinden [Gambit AI CLI](https://github.com/cekYc/gambit-ai-cli)'nin 39 görevlik benchmark'ında (Gambit Bench v2) koşturuldu. Görevler; kod yazma, hata ayıklama, kod okuma, SQL, terminal, ajan, mantık, talimat ve kod incelemeyi kapsar. Gizli testler ve rubriklerle kısmi puan verilir, genel puan zorluk ağırlıklıdır (kolay ×1 … çok zor ×4). Karşılaştırma için Gambit ile denenen en iyi yerel model, Qwen3.8 27B de tabloda.

Umay Akıllı ve Umay Hızlı üç düşünme ayarıyla, sitede 9 Kasım 2026'da eklenen Umay Ultra Hızlı ve Umay Daha Zeki düşünme açık ve kapalı koşturuldu. On yapılandırmanın hepsi aynı gece (9 Kasım 22:10 – 10 Kasım 01:10), aynı Umay CLI ile ve görev başına süre sınırı olmadan koştu.

Düşünme ayarları:

- **açık:** İstekte `enable_thinking: true` gönderilir.
- **otomatik:** Düşünme alanı gönderilmez, Umay karar verir. Umay CLI'nin varsayılanı budur.
- **kapalı:** İstekte `enable_thinking: false` gönderilir.

> **Not:** Bu sonuçlar kesin bir sıralama değildir, yalnızca bu koşuların sonucunu gösterir. Donanım, çalışma ortamı (yerel model ya da uzak API), kullanılan CLI ve ajan döngüsü, süre sınırları ve model ayarları sonuçları değiştirebilir. Her yapılandırma bir kez koşturuldu; tekrar koşularda puanlar birkaç puan oynayabilir. Umay aynı model adının arkasındaki modeli değiştirebiliyor; 9 Kasım'da iki kez değişti (aşağıda).

## Genel puan

<p align="center"><img src="kiyaslama-genel.svg" alt="Gambit Bench v2 genel puanları: Umay Akıllı düşünme açık 89,4; Umay Hızlı düşünme açık 87,2; Qwen3.8 27B 84,3; Umay Hızlı düşünme kapalı 73,9; Umay Akıllı otomatik 72,1; Umay Daha Zeki düşünme açık 71,3; Umay Akıllı düşünme kapalı 67,5; Umay Hızlı otomatik 64,9; Umay Ultra Hızlı düşünme açık 61,7; Umay Daha Zeki düşünme kapalı 52,4; Umay Ultra Hızlı düşünme kapalı 42,3" width="720"></p>

| Yapılandırma | Genel | Zor görevler | Tam puan | Sıfır puan | Kesilen yanıt | Süre |
| --- | --- | --- | --- | --- | --- | --- |
| Umay Akıllı · düşünme açık | **89,4** | **89,1** | 22 | 1 | **0** | 47 dk |
| Umay Hızlı · düşünme açık | 87,2 | 85,6 | **27** | 2 | 2 | 46 dk |
| Qwen3.8 27B · düşünme kapalı (yerel) | 84,3 | 83,4 | 17 | **0** | – | 872 dk |
| Umay Hızlı · düşünme kapalı | 73,9 | 73,7 | 13 | 1 | **0** | 21 dk |
| Umay Akıllı · otomatik | 72,1 | 70,8 | 15 | 7 | **0** | 22 dk |
| Umay Daha Zeki · düşünme açık | 71,3 | 73,5 | 8 | 2 | 1 | 49 dk |
| Umay Akıllı · düşünme kapalı | 67,5 | 64,8 | 12 | 6 | **0** | **17 dk** |
| Umay Hızlı · otomatik | 64,9 | 63,0 | 9 | 2 | **0** | 24 dk |
| Umay Ultra Hızlı · düşünme açık | 61,7 | 60,4 | 7 | 3 | **0** | 44 dk |
| Umay Daha Zeki · düşünme kapalı | 52,4 | 53,6 | 9 | 5 | **0** | 24 dk |
| Umay Ultra Hızlı · düşünme kapalı | 42,3 | 43,5 | 1 | 6 | **0** | 20 dk |

## Kategoriler

| Kategori | Akıllı açık | Akıllı otomatik | Akıllı kapalı | Hızlı açık | Hızlı otomatik | Hızlı kapalı | Qwen3.8 27B |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Kod yazma | **95** | 71 | 64 | 66 | 81 | 72 | 77 |
| Hata ayıklama | **100** | 75 | 72 | 97 | 62 | 97 | 97 |
| Kod okuma | 85 | 72 | 68 | **91** | 54 | 49 | 89 |
| SQL | 87 | 81 | 81 | 71 | 45 | 66 | **88** |
| Terminal | 98 | 27 | 45 | **100** | 73 | 93 | 78 |
| Ajan | 66 | 70 | 43 | **100** | 63 | 74 | 75 |
| Mantık | 96 | **100** | 96 | **100** | 62 | 80 | **100** |
| Talimat | 97 | 86 | 72 | **100** | 88 | 80 | 77 |
| Kod inceleme | **90** | 77 | 83 | **90** | 68 | 80 | 81 |

| Kategori | Ultra Hızlı açık | Ultra Hızlı kapalı | Daha Zeki açık | Daha Zeki kapalı |
| --- | --- | --- | --- | --- |
| Kod yazma | 45 | 38 | **71** | 46 |
| Hata ayıklama | 69 | 5 | **89** | 43 |
| Kod okuma | 52 | 38 | **58** | 37 |
| SQL | 39 | 19 | **73** | 32 |
| Terminal | 74 | 38 | 60 | **92** |
| Ajan | **81** | 56 | 62 | 26 |
| Mantık | 68 | 83 | **100** | **100** |
| Talimat | **94** | 79 | 64 | 84 |
| Kod inceleme | 83 | 83 | **86** | 79 |

En iyi Umay sonucu ile en iyi yerel sonuç, kategori kategori:

<p align="center"><img src="kiyaslama.svg" alt="Gambit Bench v2 kategori puanları: Umay Akıllı düşünme açık 89,4, Qwen3.8 27B 84,3" width="720"></p>

## Sonuçları okurken

- **Düşünme dört modelin hepsine yarıyor.** Her modelde en iyi sonuç düşünme açıkken geldi; açık ile kapalı arasındaki fark Akıllı'da 22, Ultra Hızlı'da 19, Daha Zeki'de 19, Hızlı'da 13 puan.
- **Otomatik artık kapalı gibi.** 8 Kasım'da düşünme alanı gönderilmediğinde Umay düşünüyordu: araç kullanılmayan görevlerde görev başına medyan Akıllı'da yaklaşık 4.000, Hızlı'da 9.400 karakter düşünce geldi. Bu koşuda alan gönderilmediğinde hiç düşünce gelmedi; görev kayıtları da düşünme kapalıdaki kadar kısa (Akıllı'da medyan 6.500 karakterden 1.850 karaktere indi). Puanlar da kapalıya yaklaştı. En iyi sonuç için `/dusunme ac`.
- **Kapalı gerçekten kapalı.** Kapalı yapılandırmalarda istekte `enable_thinking: false` gönderildi ve dört modelde de hiçbir yanıtta düşünce gelmedi; araç kullanılmayan görevler 2–4 saniyede bitti. Açık yapılandırmalarda her yanıtta düşünce geldi. Akıllı düşünme kapalıyken de araç çağrıları arasına "Let me fix all these:" gibi kısa İngilizce cümleler yazıyor; bunlar düşünce değil, görünür cevabın parçası (8 Kasım'da da aynıydı).
- **Akıllı ve Hızlı açıkken Qwen3.8 27B'yi geçiyor.** Akıllı kod yazma ve hata ayıklamada, Hızlı terminal, ajan ve talimatta önde. Akıllı ajan görevlerinde 66'da kaldı: Hızlı'nın 100 aldığı bu kategoride bir görevde istenen `ozet.json` dosyasını 14 adımda yazamadı, bir görevde de `API.md`'yi yanlış klasöre yazdı.
- **Ultra Hızlı ve Daha Zeki şu an aynı modeli kullanıyor gibi.** Araç kullanılmayan 14 görevde ikisi düşünme kapalıyken neredeyse aynı cevapları verdi (ör. kod okumada 65/64, 39/39, 22/22). Ultra Hızlı'nın adı hızlı ama bu iki model Akıllı ve Hızlı'nın gerisinde; düşünme kapalıyken hata ayıklama ve SQL'de çok zayıf.
- **Kesilen yanıtlar:** 8 Kasım koşularında Umay uzun düşünceleri yanıt uzunluk sınırında kesiyordu (13 sıfır). Bu koşuda bu yalnızca bir kez görüldü (Daha Zeki, bir talimat görevi). Hızlı düşünme açıkken iki görevde sunucu yanıtı 180. saniyede "Yapay zeka servisleri şu anda yanıt veremiyor" hatasıyla kesti; bunlar 0 puan sayıldı.
- **Süre:** Görev başına süre sınırı yoktu. Sunucu her isteği yaklaşık 180 saniyede kesiyor; model hiç çıktı vermeden gelen sunucu hataları (boş akış, kopan bağlantı, "servisler yanıt veremiyor") beklenip yeniden denendi, çıktı başladıktan sonraki kesilmeler sonuç sayıldı. Akıllı'nın üç yapılandırması bu yüzden sunucu düzelene kadar (yaklaşık 80 dakika) bekledi; tablodaki süreler bekleme dışıdır. Qwen3.8 27B de süre sınırı olmadan koştu ve görev başına ortalama 22 dakika harcadı.

## Önceki koşular

Aynı yapılandırmalar 8 ve 9 Kasım'da önceki Umay CLI ile de koşturulmuştu. Puanlar değişti. 9 Kasım'daki önceki koşuların dosyaları Gambit AI CLI deposunda [`benchmark/v2/results-umay-onceki`](https://github.com/cekYc/gambit-ai-cli/tree/main/benchmark/v2/results-umay-onceki) klasöründe.

| Yapılandırma | Önceki koşu | Bu koşu |
| --- | --- | --- |
| Umay Akıllı · düşünme açık | 87,6 (8 Kasım) | 89,4 |
| Umay Akıllı · otomatik | 83,2 (8 Kasım) | 72,1 |
| Umay Akıllı · düşünme kapalı | 65,2 (8 Kasım) | 67,5 |
| Umay Hızlı · düşünme açık | 81,4 (8 Kasım) | 87,2 |
| Umay Hızlı · otomatik | 79,4 (8 Kasım) | 64,9 |
| Umay Hızlı · düşünme kapalı | 68,7 (8 Kasım) | 73,9 |
| Umay Ultra Hızlı · düşünme açık | 52,1 (9 Kasım sabahı) | 61,7 |
| Umay Ultra Hızlı · düşünme kapalı | 73,7 (9 Kasım sabahı) | 42,3 |
| Umay Daha Zeki · düşünme açık | 47,9 (9 Kasım akşamı) | 71,3 |
| Umay Daha Zeki · düşünme kapalı | 40,4 (9 Kasım akşamı) | 52,4 |

Farkların üç kaynağı var:

- **Araç çağrısı onarımı.** Umay modelleri araçları metin içinde `<tool_call>` bloklarıyla çağırıyor ve uzun bir dosya içeriğinden sonra JSON'un sonunu sık sık bozuyor (eksik `}`, `}` yerine `)` ya da `]`, sonda fazladan `"}}`). Önceki CLI bu çağrıları okuyamıyordu; model de çoğu zaman dosyayı yazdığını sanıp bitiriyordu. CLI artık sondaki bu bozuklukları onarıyor (ortası bozuk çağrıyı yine reddediyor). Etkisi en temiz Daha Zeki'de görülüyor: aynı model, aynı akşam, onarımsız 47,9 ve 40,4, onarımlı 71,3 ve 52,4.
- **Otomatik modun değişmesi.** Yukarıda: Umay alan gönderilmediğinde artık düşünmüyor.
- **Modellerin değişmesi.** Daha Zeki'nin arkasındaki model 9 Kasım 16:50 civarında değişti; yanıtlar dakikalar yerine saniyelerde gelmeye başladı. Ultra Hızlı da sabahtan akşama değişti: düşünme kapalıyken araç kullanılmayan görevlerde ortalama süre 238 saniyeden 9 saniyeye, puan 92'den 63'e indi ve cevaplar Daha Zeki'ninkilerle aynılaştı. Sabahki Ultra Hızlı düşünme açıkken 3 dakikadan uzun düşünüp sunucunun 180 saniyelik kesmesine takılıyordu (14 sıfırın 10'u); bu koşuda bu hiç olmadı.

## Koşullar

| | Umay yapılandırmaları | Qwen3.8 27B |
| --- | --- | --- |
| Model | Uzak, Umay API (`umay-akilli`, `umay-hizli`, `umay-ultra-hizli`, `umay-daha-zeki`) | Yerel bilgisayarda |
| Ajan döngüsü | Umay CLI, metin tabanlı araç çağrısı (sonu bozuk çağrılar onarılır) | Gambit CLI, yerleşik araç çağrısı |
| Düşünme | Akıllı ve Hızlı: açık / otomatik / kapalı; Ultra Hızlı ve Daha Zeki: açık / kapalı | Kapalı |
| Süre sınırı | Yok (Umay sunucusu her isteği yaklaşık 180 saniyede kesiyor) | Yok |
| Ortak olanlar | Aynı 39 görev, kurulumlar ve notlandırıcılar; onaylar yalnızca görev klasörüne izin veren aynı kuralla; görev başına en fazla 14 model adımı | |

Umay koşuları 9 Kasım 2026 22:10 ile 10 Kasım 01:10 arasında yapıldı. Qwen3.8 27B değerleri Gambit Bench raporundan alındı.

## Nasıl koşturuldu

Görevler, kurulumları ve notlandırıcılar Gambit AI CLI deposundaki `benchmark/v2` klasöründedir. Umay koşuları için o klasöre şu dosyalar eklendi:

- `umay_kos.py`: Her görevin klasörünü hazırlar, onayları Gambit'in kuralıyla verir, sonucu Gambit'in notlandırıcılarıyla puanlar. `--no-thinking` kapalı, `--server-default-thinking` otomatik modu, `--sure-siniri-yok` süre sınırı olmadan koşturur.
- `umay_ajan.mjs`: Görevi Umay CLI'nin ajan döngüsüyle görev klasöründe çalıştırır; model hiç çıktı vermeden gelen sunucu hatalarında aynı isteği yeniden gönderir.
- `umay_yeni_modeller.py`: Yapılandırmaları ayrı klasörlerde aynı anda koşturur, sunucu hatasıyla biten görevleri sunucu düzelince yeniden dener ve biten yapılandırmaları sonuçlara ekler.
- `umay_grafik.py`: Bu sayfadaki iki grafiği sonuçlardan üretir.
- `umay_uc_kosu.ps1`, `umay_kapali_tekrar.ps1`: 8 Kasım koşularında kullanılan betikler.

Örnekleme ve yanıt uzunluğu Umay sunucusunun varsayılanlarıdır. Token sayıları, Umay akışta kullanım bilgisi göndermediği için kaydedilmedi.
