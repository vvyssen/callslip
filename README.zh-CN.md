# Paper Fetch

[English](README.md)

一个 Chrome 扩展：通过你自己学校的图书馆，一键把论文存成命名规范的 PDF。它是为 INFORMS 期刊（*Management Science*、*Operations Research*、*M&SOM* 等）做的，其他论文也能用。

<p>
  <img src="docs/screenshots/popup-on-page.png" width="270" alt="在 INFORMS 文章页打开：自动识别这篇论文">
  <img src="docs/screenshots/popup-page-list.png" width="270" alt="在期刊目录页打开：列出页面上的论文">
  <img src="docs/screenshots/popup-results.png" width="270" alt="粘贴标题后的匹配结果">
</p>

## 为什么做这个

INFORMS 网站不再支持我们学校的机构登录后直接下载。想拿一篇论文，得离开文章页，跳到学校图书馆的数据库里，把同一篇论文再搜一遍，然后在那边下载。Paper Fetch 替你走完这一趟：

- **在文章页一键下载。** 在 INFORMS 的文章页或目录页打开它，论文直接从页面上识别出来。
- **自动找到学校图书馆的代理。** 输入一次学校名称，代理链接自动填好。
- **登录 EBSCO 后直接下载。** 只要你已登录学校的 EBSCO，它会在后台到 EBSCO 里搜索并下载这篇论文。
- **只有标题也行。** 手上只有标题时，通过 Crossref 搜索，由你选出匹配的那一篇。

它始终只使用你自己的学校认证，见[免责声明](#免责声明)。

## 它做什么

**在 INFORMS 页面上**

- 在文章页点 Paper Fetch 按钮，论文会从页面上直接识别出来；按 <kbd>Enter</kbd> 就保存。
- 在某一期的目录页、Articles in Advance 列表或搜索结果页，会列出页面上的全部论文；用 <kbd>↑</kbd> <kbd>↓</kbd> 选一篇，按 <kbd>Enter</kbd>。
- 通过学校图书馆代理访问 INFORMS 时也一样可用。

**在其他地方**

- 其他出版社的文章页同样能识别，只要页面里标明了 DOI。
- 或者粘贴任意标题或 DOI。扩展会到 [Crossref](https://www.crossref.org/) 查询，按匹配度列出结果。

**怎么拿到 PDF。** 按下面的顺序尝试，拿到 PDF 就停：

| 途径 | 什么时候能用 |
| --- | --- |
| 当前页面 | 你所在的页面带有 PDF 链接，而且你在这个页面上有访问权限 |
| 出版社 | 你在校园网或学校 VPN 里，或者这篇文章免费 |
| 图书馆代理 | 你已登录学校图书馆的 EZproxy |
| EBSCO | 学校订了 EBSCO，并且你已登录 |
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
| 学校订了 EBSCO | 在这个浏览器里登录一次 EBSCO，其余自动识别。 |

登录之后，设置页里的 **Sign in** 按钮会自动变成红色的 **Sign out**，一眼就能看出图书馆会话是否有效，用完也可以点它退出。第一次点 Sign in 时，Chrome 会询问是否允许 Paper Fetch 读取学校代理的页面；这个权限只用于判断登录状态，拒绝也不影响其他功能。

学校搜索覆盖约 1500 所使用 EZproxy 的图书馆，数据来自公开目录 [libproxy-db.org](https://libproxy-db.org/)（学校名称为英文）。如果没有你的学校，有两个办法：把图书馆网站上任意一个经过代理的链接粘贴进去（会自动截取有用的部分）；或者在图书馆登录页上打开弹窗，点 **Use it for downloads**。

## 关于 EBSCO

EBSCO 不是某个学科的数据库，而是一个平台，上面有图书馆订购的许多数据库，各有侧重：Business Source 面向商科与管理，Academic Search 面向综合学术，另外还有心理学、教育、护理等方向。对商学院来说最重要的是第一个，它收录了大量管理类期刊的全文。具体能看到哪些库、哪些年份，取决于学校的订购。当出版社网站拿不到 PDF 时，Paper Fetch 把 EBSCO 当作另一条获取途径。

## 支持范围

**INFORMS 期刊**都在同一个网站上，地址规则统一，所以全部支持：*Management Science*、*Operations Research*、*Manufacturing & Service Operations Management*、*Marketing Science*、*Information Systems Research*、*Organization Science*、*Mathematics of Operations Research*、*Transportation Science*、*INFORMS Journal on Computing*、*Decision Analysis*、*Strategy Science*，以及 pubsonline.informs.org 上的其他期刊。

**其他可以直连 PDF 的出版社：** Wiley、Springer（含 Palgrave）、Taylor & Francis、Sage、Nature、Science、PNAS、ACS、ACM、SIAM、Academy of Management、芝加哥大学出版社、Royal Society、ASCE、IOP。其余出版社（Elsevier、IEEE、牛津、剑桥、JSTOR 等）在文章页上打开时会用页面自带的 PDF 链接，其次是 EBSCO 和开放获取；再不行就给你文章页面。

**测试到什么程度。** 自动化测试用仿照真实网站搭建的替身服务器把每条途径都跑了一遍，另外实际请求了 Crossref、OpenAlex，并真实下载了两篇开放获取论文。INFORMS 网站会拦截自动化浏览器，所以页面识别是在地址和标签都相同的替身页面上测的，没有在真实网站上测。真实使用只在一所大学的图书馆跑过。欢迎其他学校的反馈，成不成都有用。

**已知限制**

- EBSCO 这条途径是操作它的网页实现的，所以 EBSCO 界面语言必须是英文；对方改版也可能导致失效。
- 改写网址的 WebVPN 门户（内地高校常见）不能当作代理链接用。在校园网或全局 VPN 下，出版社直连本来就能用，不需要它。
- 学校目录里的代理链接按原样使用，个别可能已过期。在设置里点 **Sign in** 就能马上看出你的链接是否有效。
- INFORMS 以外各出版社的直连地址按平台通用规则填写，只有 Nature 和 IOP 在真实网站上确认过。

## 隐私

Paper Fetch 没有自己的服务器，也没有任何统计。你搜索的标题或 DOI 会发给 Crossref；你下载的论文的 DOI 会发给 OpenAlex；下载请求发给出版社、图书馆代理或 EBSCO，和你自己点链接没有区别。点击扩展按钮时，它会读取当前页面的地址和文章标签，这些信息不会离开浏览器。设置只存在浏览器里。它用的是你已经登录的会话，接触不到密码。详见 [PRIVACY.md](PRIVACY.md)。

申请的权限：**activeTab**（读取你点击按钮时所在的页面）、**downloads**（保存 PDF）、**storage**（保存设置）、**在 ebsco.com 上运行脚本**（在 EBSCO 页面上执行搜索）。另有一项可选权限，仅在询问时你同意才会获得：**读取学校代理网站**，用于显示是否已登录。

## 免责声明

- **只使用你自己的访问权限。** Paper Fetch 通过你本人在自己浏览器里完成的学校认证登录来下载。它没有自己的账号或访问权限，也接触不到你的密码。
- **不提供代下载。** 它不提供论文，不共享任何人的访问权限，也不替任何人下载。你的图书馆没有给你的论文，Paper Fetch 同样拿不到（合法的开放获取版本除外）。
- **请勿批量下载。** 出版社的许可协议禁止系统性下载，图书馆可能因此被暂停访问。Paper Fetch 只在你点的时候下载一篇。请不要用脚本驱动它，也不要用它整期、整刊地抓取。
- 遵守学校图书馆和出版社的使用条款是使用者自己的责任。Paper Fetch 是独立项目，与 INFORMS、EBSCO、Crossref、OpenAlex 以及任何出版社或图书馆均无关联。

## 开发

```
node tests/unit.mjs extension      # 标题匹配、文件命名、页面与代理链接处理
node tests/e2e.mjs                 # 在无头 Chrome 里驱动真实扩展
node tests/e2e.mjs --shots docs/screenshots
scripts/package.sh                 # 生成 dist/paper-fetch-<版本>.zip
node scripts/icons.mjs              # 由 icons/icon.svg 重新生成各尺寸 PNG 图标
```

端到端测试需要 Chrome、`openssl` 和网络，用的是独立的临时浏览器配置，不会碰你自己的浏览器。

没有构建步骤，没有依赖。

## 许可证

[MIT](LICENSE)
