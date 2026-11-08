# Kıyaslama: Gambit Bench v2

Umay Akıllı, [Umay CLI](../README.md) ile [Gambit AI CLI](https://github.com/cekYc/gambit-ai-cli)'nin 39 görevlik benchmark'ında (Gambit Bench v2) koşturuldu. Görevler; kod yazma, hata ayıklama, SQL, terminal, ajan, mantık, talimat ve kod incelemeyi kapsar. Gizli testler ve rubriklerle kısmi puan verilir, genel puan zorluk ağırlıklıdır.

<p align="center"><img src="kiyaslama.svg" alt="Gambit Bench v2 kategori puanları: Umay Akıllı 87,6, Qwen3.8 27B 84,3" width="720"></p>

| | Umay Akıllı (düşünme açık) | Qwen3.8 27B (yerel, düşünme kapalı) |
| --- | --- | --- |
| Genel puan | **87,6** | 84,3 |
| Zor görevler | **86,5** | 83,4 |
| Tam puan / sıfır puan | **21** / 1 | 17 / **0** |
| Toplam süre | **45 dk** | 872 dk |
| Öne çıktığı kategoriler | Terminal (95'e 78), ajan (90'a 75), kod yazma (85'e 77) | Talimat (77'ye 51), mantık (100'e 96), kod inceleme (81'e 77) |

Qwen3.8 27B, Gambit ile denenen yerel modellerin en iyisiydi. İki koşuda görevler, puanlama, güvenlik kuralı (yalnızca görev klasörü) ve görev başına 14 adım aynıdır. Farklı olanlar: Umay uzak API'de çalışan bir model ve Umay CLI'nin ajan döngüsüyle (metin tabanlı araç çağrısı), Gambit'in süre sınırlarıyla (araçlı görevde 8, araçsızda 5 dakika) koştu. Qwen3.8 27B yerel bilgisayarda Gambit CLI'nin ajan döngüsüyle, düşünme kapalı ve süre sınırı olmadan koştu. Umay'ın tek sıfırı, düşünürken yanıt uzunluk sınırına takılıp cevap yazamadığı bir talimat göreviydi. Koşu 8 Kasım 2026'da yapıldı.

> **Not:** Bu karşılaştırma kesin bir sıralama değildir, yalnızca bu iki koşunun sonucunu gösterir. Donanım, çalışma ortamı (yerel model ya da uzak API), kullanılan CLI ve ajan döngüsü, süre sınırları ve model ayarları sonuçları değiştirebilir. Her yapılandırma bir kez koşturuldu; tekrar koşularda puanlar birkaç puan oynayabilir.

## Nasıl koşturuldu

Görevler, kurulumları ve notlandırıcılar Gambit AI CLI deposundaki `benchmark/v2` klasöründedir. Umay koşusu için o klasöre iki dosya eklendi: `umay_kos.py` her görevin klasörünü hazırlar, onayları Gambit'in kuralıyla verir ve sonucu Gambit'in notlandırıcılarıyla puanlar; `umay_ajan.mjs` görevi Umay CLI'nin ajan döngüsüyle görev klasöründe çalıştırır. Örnekleme ve yanıt uzunluğu Umay sunucusunun varsayılanlarıdır; token sayıları Umay akışta kullanım bilgisi göndermediği için kaydedilmedi.
