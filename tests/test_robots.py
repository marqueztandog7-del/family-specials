from family_specials.http import RobotsRules

COLES = """
User-agent: *

Disallow: /search/
Disallow: /*/*/*/on-special*
Disallow: /brand/*
Allow: /on-special?filter_Special=halfprice
Disallow: *?filter_Special=*
Disallow: /product/*$
Allow: /product/*-*

User-agent: AdsBot-Google
Disallow:
"""


def test_coles_rules():
    r = RobotsRules.parse(COLES)
    assert r.allowed("/on-special")
    assert r.allowed("/on-special?page=2")
    assert r.allowed("/on-special?filter_Special=halfprice")
    assert not r.allowed("/on-special?filter_Special=multisave")
    assert not r.allowed("/search/products?q=milk")
    # The lighter Next.js data route for specials is caught by the category-specials rule.
    assert not r.allowed("/_next/data/123/en/on-special.json?page=2")
    assert r.allowed("/_next/data/123/en/browse/dairy-eggs-fridge/milk.json?slug=dairy-eggs-fridge&slug=milk")
    assert not r.allowed("/product/")
    assert r.allowed("/product/smith's-chips-380g-4826829")


def test_specific_agent_group_and_empty_disallow():
    text = "User-agent: *\nDisallow: /\n\nUser-agent: FamilySpecialsFinder\nDisallow:\n"
    assert RobotsRules.parse(text).allowed("/anything")


def test_no_rules_allows_everything():
    assert RobotsRules().allowed("/whatever?x=1")
