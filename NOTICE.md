# Kaynaklar ve Lisanslar

## Gambit AI CLI

Umay CLI'nin yerel araçları (`python/tools.py`), aynı yazarın [Gambit AI CLI](https://github.com/cekYc/gambit-ai-cli) projesindeki `ai-cli/tools.py` dosyasından gelir ve komut iptali eklenerek değiştirilmiştir. Gambit AI CLI de PolyForm Noncommercial License 1.0.0 ile lisanslanmıştır; bu dosya burada Umay CLI'nin [LICENSE](LICENSE) koşullarıyla (Umay için ek izin dahil) dağıtılır. Gambit'in 8 Kasım 2026'dan önceki sürümleri MIT Lisansı ile yayımlanmıştı.

Gambit'teki ajan davranışı (araç tanımları, fark önizlemesi, onay akışı, geri alma) Umay CLI'nin araç sistemine örnek olmuştur. Yerel model yükleme, LM Studio bağlantısı ve Gambit'in yapılandırma dosyaları taşınmamıştır.

## Bağımlılıklar

Bu depo bağımlılıkların kodunu içermez; `npm ci` ile kurulurlar. Her biri kendi lisansıyla dağıtılır.

| Paket | Kullanım | Lisans |
| --- | --- | --- |
| [ai](https://github.com/vercel/ai) | Model istekleri, akış | Apache-2.0 |
| [@ai-sdk/openai-compatible](https://github.com/vercel/ai) | OpenAI uyumlu Umay API bağlantısı | Apache-2.0 |
| [pptxgenjs](https://github.com/gitbrent/PptxGenJS) | `/sunum` PowerPoint dosyaları | MIT |
| [docx](https://github.com/dolanmiu/docx) | `/dokuman` Word dosyaları | MIT |
| [exceljs](https://github.com/exceljs/exceljs) | `/rapor` Excel dosyaları, Excel eklerini okuma | MIT |
| [jszip](https://github.com/Stuk/jszip) | `/proje` zip paketi, Word/PowerPoint eklerini okuma | MIT veya GPL-3.0-or-later (MIT seçilmiştir) |

`/sema` komutunun ürettiği HTML dosyası, tarayıcıda açılınca [Mermaid](https://github.com/mermaid-js/mermaid) kütüphanesini (MIT) jsDelivr üzerinden yükler.

`package.json` içindeki `overrides`, güvenlik uyarısı bulunan iki alt bağımlılığı düzeltilmiş sürümlere sabitler: `image-size` (pptxgenjs üzerinden) ve `uuid` (exceljs üzerinden).

## Marka

"Umay", "Umay Akıllı", "Umay Hızlı" ve Umay logosu, Umay yapay zeka hizmetinin ([umayzeka.com](https://umayzeka.com)) sahiplerine aittir. Bu proje Umay ekibine sunulmak üzere hazırlanmış bağımsız bir istemcidir; Umay tarafından onaylanana kadar resmî bir Umay ürünü değildir.
