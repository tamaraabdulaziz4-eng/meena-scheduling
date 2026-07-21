"""Crawl4AI-powered research tools: search the web AND crawl the results.

search(query)          -> list of {title, url} via DuckDuckGo HTML results
crawl(url)             -> markdown content of a page
research(query, n, k)  -> full loop: search, crawl top-k results, return corpus

Used by agents (pricing, growth, marketing) to gather fresh market intel.
"""
import asyncio
import os
import re
from urllib.parse import quote, unquote

os.environ.setdefault("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt")

from crawl4ai import AsyncWebCrawler  # noqa: E402
from crawl4ai.async_crawler_strategy import AsyncHTTPCrawlerStrategy  # noqa: E402


async def _search_async(query: str, n: int = 8) -> list[dict]:
    url = f"https://html.duckduckgo.com/html/?q={quote(query)}"
    strat = AsyncHTTPCrawlerStrategy()
    async with AsyncWebCrawler(crawler_strategy=strat) as crawler:
        r = await crawler.arun(url=url)
        if not r.success:
            return []
        links = re.findall(r"\[([^\]]{15,120})\]\((https?://[^)]+)\)", r.markdown or "")
        results, seen = [], set()
        for title, link in links:
            if "duckduckgo" in link:
                m = re.search(r"uddg=([^&]+)", link)
                if not m:
                    continue
                link = unquote(m.group(1))
            dom = link.split("/")[2] if "://" in link else ""
            if not dom or dom in seen or "duckduckgo" in dom:
                continue
            seen.add(dom)
            results.append({"title": title.strip(), "url": link})
            if len(results) >= n:
                break
        return results


async def _crawl_async(url: str, max_chars: int = 8000) -> str:
    strat = AsyncHTTPCrawlerStrategy()
    async with AsyncWebCrawler(crawler_strategy=strat) as crawler:
        try:
            r = await crawler.arun(url=url)
            return (r.markdown or "")[:max_chars] if r.success else ""
        except Exception:
            return ""


def search(query: str, n: int = 8) -> list[dict]:
    """Search the web. Returns [{title, url}]."""
    return asyncio.run(_search_async(query, n))


def crawl(url: str, max_chars: int = 8000) -> str:
    """Crawl one page, return its markdown."""
    return asyncio.run(_crawl_async(url, max_chars))


def research(query: str, n_results: int = 8, crawl_top: int = 3, max_chars: int = 6000) -> dict:
    """Full research loop: search, then crawl the top results.

    Returns {"query", "results": [{title,url}], "pages": [{url, content}]}.
    """
    async def _run():
        results = await _search_async(query, n_results)
        pages = []
        for r in results[:crawl_top]:
            content = await _crawl_async(r["url"], max_chars)
            if content:
                pages.append({"url": r["url"], "content": content})
        return {"query": query, "results": results, "pages": pages}

    return asyncio.run(_run())


if __name__ == "__main__":
    import json
    import sys

    q = sys.argv[1] if len(sys.argv) > 1 else "resume optimizer market 2026"
    out = research(q, crawl_top=2)
    print(json.dumps({"query": out["query"],
                      "results": out["results"][:5],
                      "pages": [{"url": p["url"], "chars": len(p["content"])} for p in out["pages"]]},
                     indent=2))
