# 取经 · Callslip

<img src="extension/icons/icon128.png" width="84" align="right" alt="取经：一张盖了印的索书单">

[English](README.md)

**INFORMS 文章一键下载。** 一个 Chrome 扩展：通过你自己学校的图书馆，一键把论文存成命名规范的 PDF。它是为 INFORMS 期刊（*Management Science*、*Operations Research*、*M&SOM* 等）做的，其他论文也能用。

<p>
  <img src="docs/screenshots/popup-on-page.png" width="270" alt="在 INFORMS 文章页打开：自动识别这篇论文">
  <img src="docs/screenshots/popup-page-list.png" width="270" alt="在期刊目录页打开：列出页面上的论文">
  <img src="docs/screenshots/popup-results.png" width="270" alt="粘贴标题后的匹配结果">
</p>

## 为什么做这个

INFORMS 网站不再支持我们学校的机构登录后直接下载。想拿一篇论文，得离开文章页，跳到学校图书馆的数据库里，把同一篇论文再搜一遍，然后在那边下载。取经 替你走完这一趟：

- **在文章页一键下载。** 在 INFORMS 的文章页或目录页打开它，论文直接从页面上识别出来。
- **自动找到学校图书馆的代理。** 输入一次学校名称，代理链接自动填好。
- **登录 EBSCO 后直接下载。** 只要你已登录学校的 EBSCO，它会按 DOI 打开这篇论文在 EBSCO 里的页面，把图书馆在那里提供的 PDF 存下来。不用搜索，也没有需要填写的设置。
- **只有标题也行。** 手上只有标题时，通过 Crossref 搜索，由你选出匹配的那一篇。

它始终只使用你自己的学校认证，见[免责声明](#免责声明)。

**关于名字。** Callslip 是图书馆的索书单：填一张单子交给服务台，馆员从书库里取出一件，一单一件。这个扩展拿着 DOI 做的就是这件事。中文名“取经”出自《西游记》：经是一关一关递上通关文牒、盖了印才取回来的，不是绕过关卡拿到的。图标就是这张盖了印的单子。

## 它做什么

**在 INFORMS 页面上**

- 在文章页点“取经”按钮，论文会从页面上直接识别出来；按 <kbd>Enter</kbd> 就保存。打开 **Auto-download** 开关后，点一下按钮就直接保存。页面认不出来时，弹窗就是原来的搜索框。
- 在某一期的目录页、Articles in Advance 列表或搜索结果页，会列出页面上的全部论文；用 <kbd>↑</kbd> <kbd>↓</kbd> 选一篇，按 <kbd>Enter</kbd>。
- 通过学校图书馆代理访问 INFORMS 时也一样可用。

**在其他地方**

- 其他出版社的文章页同样能识别，只要页面里标明了 DOI。
- 或者粘贴任意标题或 DOI。扩展会到 [Crossref](https://www.crossref.org/) 查询，按匹配度列出结果。

**怎么拿到 PDF。** 通往正式发表版的几条途径同时尝试，哪条先返回 PDF 就从哪条下载，其余立即停止，所以某个网站响应慢或拒绝访问不会拖住能用的那条。这些途径都拿不到时才用开放获取，因为免费版本常常是论文较早的稿子。INFORMS 论文是例外：图书馆只能通过 EBSCO 拿到它们，所以先只问 EBSCO，EBSCO 没有结果时才会去请求 INFORMS 网站。

| 途径 | 什么时候能用 |
| --- | --- |
| 当前页面 | 你所在的页面带有 PDF 链接，而且你在这个页面上有访问权限 |
| 出版社 | 你在校园网或学校 VPN 里，或者这篇文章免费 |
| 图书馆代理 | 你已登录学校图书馆的 EZproxy |
| EBSCO | 学校在 EBSCO 里有这篇论文，并且你已登录 |
| 开放获取 | [OpenAlex](https://openalex.org/) 收录了免费版本 |

文件存到"下载"文件夹，命名为 `<第一作者姓><年份><标题首词>.pdf`，例如 `green2019sharp.pdf`。如果所有途径都失败，弹窗会说明每一条卡在哪，并给一个按钮通过图书馆打开文章页面。下载过程中关掉弹窗不影响下载。

## 安装

目前还没上架 Chrome 应用商店，需要从源码加载：

1. 下载本仓库（Code → Download ZIP 后解压），或者 `git clone`。
2. 打开 `chrome://extensions`，打开右上角的**开发者模式**，点**加载已解压的扩展程序**，选择 `extension` 文件夹。

第一次安装会自动打开设置页。

## 按你学校的情况设置

| 你的情况 | 怎么做 |
| --- | --- |
| 在校园网，或连着学校 VPN | 什么都不用设。 |
| 在校外 | 在设置里输入学校名称，选中它，然后点 **Sign in**。 |
| 学校订了 EBSCO | 在这个浏览器里登录一次 EBSCO，此外不需要任何设置。 |
| 学校没有 EBSCO | 在设置里把 EBSCO 关掉。 |

登录之后，设置页里的 **Sign in** 按钮会自动变成红色的 **Sign out**，一眼就能看出图书馆会话是否有效，用完也可以点它退出。第一次点 Sign in 时，Chrome 会询问是否允许“取经”读取学校代理的页面；这个权限只用于判断登录状态，拒绝也不影响其他功能。

学校搜索覆盖约 1500 所使用 EZproxy 的图书馆，数据来自公开目录 [libproxy-db.org](https://libproxy-db.org/)（学校名称为英文）。如果没有你的学校，有两个办法：把图书馆网站上任意一个经过代理的链接粘贴进去（会自动截取有用的部分）；或者在图书馆登录页上打开弹窗，点 **Use it for downloads**。

## 关于 EBSCO

EBSCO 不是某个学科的数据库，而是一个平台，上面有图书馆订购的许多数据库，各有侧重：Business Source 面向商科与管理，Academic Search 面向综合学术，另外还有心理学、教育、护理等方向。对商学院来说最重要的是第一个，它收录了大量管理类期刊的全文。具体能看到哪些库、哪些年份，取决于学校的订购。当出版社网站拿不到 PDF 时，取经 把 EBSCO 当作另一条获取途径。对 INFORMS 期刊来说，这是图书馆唯一的途径：从 2026 年起，INFORMS 的机构在线访问只通过 EBSCO 提供。

**取经怎么用 EBSCO。** EBSCO 为每篇文章公开了一个按 DOI 访问的地址，图书馆的链接解析器和 EBSCO 自己的 Passport 扩展走的都是这个入口。取经 在后台标签页里打开这个地址。如果你已登录、学校也有全文，EBSCO 会把标签页转到它的 PDF 阅读页。阅读页向 EBSCO 请求 PDF 的那一刻，取经 就把同一个地址存下来并关掉标签页，所以文件只取一次。它不在 EBSCO 里搜索，不往页面里输入，也不点任何按钮。

## 支持范围

**INFORMS 期刊**都在同一个网站上，地址规则统一，所以全部支持：*Management Science*、*Operations Research*、*Manufacturing & Service Operations Management*、*Marketing Science*、*Information Systems Research*、*Organization Science*、*Mathematics of Operations Research*、*Transportation Science*、*INFORMS Journal on Computing*、*Decision Analysis*、*Strategy Science*，以及 pubsonline.informs.org 上的其他期刊。

**其他可以直连 PDF 的出版社：** Wiley、Springer（含 Palgrave）、Taylor & Francis、Sage、Nature、Science、PNAS、ACS、ACM、SIAM、Academy of Management、芝加哥大学出版社、Royal Society、ASCE、IOP。其余出版社（Elsevier、IEEE、牛津、剑桥、JSTOR 等）在文章页上打开时会用页面自带的 PDF 链接，其次是 EBSCO 和开放获取；再不行就给你文章页面。

**测试到什么程度。** 自动化测试用仿照真实网站搭建的替身服务器把每条途径都跑了一遍，另外实际请求了 Crossref、OpenAlex，并真实下载了两篇开放获取论文。INFORMS 网站会拦截自动化浏览器，所以弹窗是在替身页面上测的（地址和标签取自真实的 INFORMS 文章页，包括页面还没加载完的情况），没有在真实网站上测。真实使用只在一所大学的图书馆跑过，其中包括 EBSCO 这条途径：用该校的登录，从真实的 EBSCO 存下了一篇 *Management Science* 的文章。欢迎其他学校的反馈，成不成都有用。

**已知限制**

- EBSCO 这条途径依赖 EBSCO 那边的三样东西：按 DOI 访问的地址、PDF 阅读页、阅读页取 PDF 的服务器。其中任何一样改了，这条途径就会失效，直到 取经 更新；届时弹窗会给出这篇论文的 EBSCO 页面，可以手动打开。
- 改写网址的 WebVPN 门户（内地高校常见）不能当作代理链接用。在校园网或全局 VPN 下，出版社直连本来就能用，不需要它。
- 学校目录里的代理链接按原样使用，个别可能已过期。在设置里点 **Sign in** 就能马上看出你的链接是否有效。
- INFORMS 以外各出版社的直连地址按平台通用规则填写，只有 Nature 和 IOP 在真实网站上确认过。

## 隐私

取经 没有自己的服务器，也没有任何统计。你搜索的标题或 DOI 会发给 Crossref；你下载的论文的 DOI 会发给 OpenAlex；下载请求发给出版社、图书馆代理或 EBSCO，和你自己点链接没有区别。点击扩展按钮时，它会读取当前页面的地址和文章标签，这些信息不会离开浏览器。设置只存在浏览器里。它用的是你已经登录的会话，接触不到密码。详见 [PRIVACY.md](PRIVACY.md)。

申请的权限：**activeTab**（读取你点击按钮时所在的页面）、**downloads**（保存 PDF）、**storage**（保存设置）、**在 ebsco.com 上运行脚本**（查看 EBSCO 页面走到了哪一步）、**观察 EBSCO 站点的网络请求**（得知阅读页向哪个地址请求 PDF；只观察，不拦截也不修改）。另有一项可选权限，仅在询问时你同意才会获得：**读取学校代理网站**，用于显示是否已登录。

## 免责声明

- **只使用你自己的访问权限。** 取经 通过你本人在自己浏览器里完成的学校认证登录来下载。它没有自己的账号或访问权限，也接触不到你的密码。
- **不提供代下载。** 它不提供论文，不共享任何人的访问权限，也不替任何人下载。你的图书馆没有给你的论文，取经 同样拿不到（合法的开放获取版本除外）。
- **请勿批量下载。** 出版社的许可协议禁止系统性下载，图书馆可能因此被暂停访问。取经 点一次只存一篇，并且在设计上保证如此（见[它不会做的事](#它不会做的事)）。请不要用脚本驱动它，也不要用它整期、整刊地抓取。
- 遵守学校图书馆和出版社的使用条款是使用者自己的责任。取经 是独立项目，与 INFORMS、EBSCO、Crossref、OpenAlex 以及任何出版社或图书馆均无关联。

## 它不会做的事

下面这些是代码本身的性质，不是对使用者的要求。

- **点一次，存一篇。** 没有队列，没有“全部下载”，没有定时任务，不按按钮就什么都不做。一篇还在下载时不能开始下一篇；浏览器打开期间已经存过的论文，自动下载不会再取第二次。
- **每小时最多 30 篇。** 到了上限会告诉你下一篇什么时候可以下。一篇一篇读论文的人碰不到这个上限，脚本会。
- **不在任何网站上扮演机器人。** 它打开的是出版社和 EBSCO 专门为此公开的地址，保存的是对方发给你浏览器的 PDF；不填表单，不点对方页面上的按钮。
- **下载 INFORMS 论文时，不向 INFORMS 网站多要任何东西**，只读你正在看的那个页面，前提是 EBSCO 里有这篇论文。
- **不绕过任何关卡。** 遇到登录页、付费墙或人机验证就停下，把页面交给你。
- **不碰影子图书馆。** 它找的免费版本只限 OpenAlex 列出的合法开放获取版本。

## 开发

```
node tests/unit.mjs extension      # 标题匹配、文件命名、页面与代理链接处理
node tests/e2e.mjs                 # 在无头 Chrome 里驱动真实扩展
node tests/e2e.mjs --shots docs/screenshots
scripts/package.sh                 # 生成 dist/callslip-<版本>.zip
node scripts/icons.mjs              # 由 icons/icon.svg 重新生成各尺寸 PNG 图标
```

端到端测试需要 Chrome、`openssl` 和网络，用的是独立的临时浏览器配置，不会碰你自己的浏览器。

没有构建步骤，没有依赖。

## 许可证

[MIT](LICENSE)
