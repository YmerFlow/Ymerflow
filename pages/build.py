#!/usr/bin/env python3
"""Build GitHub Pages static site from markdown source files.

Source: README.md (→ index.html) + docs/**/*.md (→ docs/**/*.html)
Output: pages/_site/
"""

import re
import shutil
from pathlib import Path

import markdown
from jinja2 import Environment, FileSystemLoader
from pygments.formatters import HtmlFormatter

REPO_ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = Path(__file__).resolve().parent
OUT_DIR = PAGES_DIR / "_site"


def get_title(md_file: Path) -> str:
    """Extract first H1 text from a markdown file, fallback to filename."""
    text = md_file.read_text(encoding="utf-8")
    m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if m:
        return re.sub(r"[*_`]", "", m.group(1)).strip()
    return md_file.stem.replace("-", " ").replace("_", " ").title()


def section_label(key: str) -> str:
    """'plans/done' → 'Plans / Done'"""
    return " / ".join(
        part.replace("-", " ").replace("_", " ").title() for part in key.split("/")
    )


def rewrite_md_links(html: str) -> str:
    """Rewrite .md hrefs to .html in rendered HTML (preserves anchors)."""
    return re.sub(
        r'href="([^"#][^"]*?)\.md(#[^"]*)?\"',
        lambda m: f'href="{m.group(1)}.html{m.group(2) or ""}"',
        html,
    )


def collect_pages(docs_dir: Path) -> list[dict]:
    """Walk docs/ tree and collect all .md files as page descriptors."""
    pages = []
    for src in sorted(docs_dir.rglob("*.md")):
        rel = src.relative_to(docs_dir)
        parent = rel.parent
        section_key = str(parent) if str(parent) != "." else None
        url_path = "docs/" + str(rel.with_suffix(".html"))
        pages.append(
            {
                "out": OUT_DIR / "docs" / rel.with_suffix(".html"),
                "src": src,
                "url": url_path,
                "title": get_title(src),
                "section": section_key,
            }
        )
    return pages


def build_nav(pages: list[dict]) -> tuple[list, dict]:
    """Split pages into top-level list and ordered section dict."""
    top_level = [{"url": p["url"], "title": p["title"]} for p in pages if p["section"] is None]
    sections: dict[str, dict] = {}
    for p in pages:
        key = p["section"]
        if key is None:
            continue
        if key not in sections:
            sections[key] = {"label": section_label(key), "pages": []}
        sections[key]["pages"].append({"url": p["url"], "title": p["title"]})
    return top_level, sections


def render_page(
    *,
    template,
    out_path: Path,
    src_path: Path,
    url_path: str,
    title: str,
    top_level_nav: list,
    section_nav: dict,
    md_converter,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    md_converter.reset()
    body_html = md_converter.convert(src_path.read_text(encoding="utf-8"))
    body_html = rewrite_md_links(body_html)
    toc_html = md_converter.toc

    depth = len(Path(url_path).parts) - 1
    root_prefix = "../" * depth if depth > 0 else "./"

    html = template.render(
        title=title,
        content=body_html,
        toc=toc_html,
        url_path=url_path,
        top_level_nav=top_level_nav,
        section_nav=section_nav,
        root_prefix=root_prefix,
    )
    out_path.write_text(html, encoding="utf-8")


def main() -> None:
    print(f"Building site → {OUT_DIR}")

    # Clean output dir
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    # Copy static assets
    shutil.copytree(PAGES_DIR / "assets", OUT_DIR / "assets")

    # Write Pygments CSS into assets
    formatter = HtmlFormatter(style="friendly", cssclass="highlight")
    (OUT_DIR / "assets" / "pygments.css").write_text(
        formatter.get_style_defs(".highlight"), encoding="utf-8"
    )

    # Copy CNAME so GitHub Pages serves the custom domain
    cname = REPO_ROOT / "CNAME"
    if cname.exists():
        shutil.copy(cname, OUT_DIR / "CNAME")

    # Mirror frontend/public for images referenced from README (e.g. YmerFlow.jpg)
    pub_dir = REPO_ROOT / "frontend" / "public"
    if pub_dir.exists():
        dest = OUT_DIR / "frontend" / "public"
        dest.mkdir(parents=True, exist_ok=True)
        for f in pub_dir.iterdir():
            if f.is_file():
                shutil.copy(f, dest / f.name)

    # Copy screenshots referenced from README
    screenshots_dir = REPO_ROOT / "screenshots"
    if screenshots_dir.exists():
        shutil.copytree(screenshots_dir, OUT_DIR / "screenshots")

    # Set up markdown converter
    md_converter = markdown.Markdown(
        extensions=["tables", "fenced_code", "codehilite", "toc", "attr_list", "def_list", "md_in_html"],
        extension_configs={
            "codehilite": {"css_class": "highlight", "guess_lang": False},
            "toc": {"title": "Contents"},
        },
    )

    # Jinja2
    jenv = Environment(loader=FileSystemLoader(str(PAGES_DIR)), autoescape=False)
    template = jenv.get_template("template.html")

    # Collect docs pages
    docs_dir = REPO_ROOT / "docs"
    docs_pages = collect_pages(docs_dir)
    top_level_nav, section_nav = build_nav(docs_pages)

    # All pages: home first, then docs
    all_pages = [
        {
            "out": OUT_DIR / "index.html",
            "src": REPO_ROOT / "README.md",
            "url": "index.html",
            "title": "Home",
        }
    ] + docs_pages

    # Render
    for page in all_pages:
        render_page(
            template=template,
            out_path=page["out"],
            src_path=page["src"],
            url_path=page["url"],
            title=page["title"],
            top_level_nav=top_level_nav,
            section_nav=section_nav,
            md_converter=md_converter,
        )
        print(f"  {page['url']}")

    print(f"\nDone: {len(all_pages)} pages")


if __name__ == "__main__":
    main()
