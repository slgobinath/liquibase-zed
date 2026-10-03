#!/usr/bin/env python3
"""Generate src/liquibase-model.json (element -> attributes/children) from dbchangelog-latest.xsd.

Usage: tools/gen_model.py [path-to-xsd]   (downloads the latest XSD when omitted)
"""
import json, sys, urllib.request
import xml.etree.ElementTree as ET

URL = "https://raw.githubusercontent.com/liquibase/liquibase/master/liquibase-standard/src/main/resources/www.liquibase.org/xml/ns/dbchangelog/dbchangelog-latest.xsd"
NS = "{http://www.w3.org/2001/XMLSchema}"

src = open(sys.argv[1], "rb").read() if len(sys.argv) > 1 else urllib.request.urlopen(URL).read()
root = ET.fromstring(src)

types = {c.get("name"): c for c in root.findall(NS + "complexType")}
groups = {c.get("name"): c for c in root.findall(NS + "attributeGroup")}
egroups = {c.get("name"): c for c in root.findall(NS + "group")}
model = {}


def entry(name):
    return model.setdefault(name, {"attrs": set(), "children": set(), "open": False})


def collect(node, e):
    """Walk a complexType-ish node, filling attrs/children of entry e."""
    for ch in node:
        tag = ch.tag.replace(NS, "")
        if tag == "attribute":
            n = ch.get("name") or (ch.get("ref") or "").split(":")[-1]
            if n:
                e["attrs"].add(n)
        elif tag == "attributeGroup":
            ref = (ch.get("ref") or "").split(":")[-1]
            if ref in groups:
                collect(groups[ref], e)
        elif tag == "any":  # anyAttribute is ##other-namespace only, so it stays strict
            e["open"] = True
        elif tag == "element":
            child(ch, e)
        elif tag == "group":
            ref = (ch.get("ref") or "").split(":")[-1]
            if ref in egroups:
                collect(egroups[ref], e)
        elif tag == "extension":
            base = (ch.get("base") or "").split(":")[-1]
            if base in types:
                collect(types[base], e)
            collect(ch, e)
        else:  # sequence, choice, all, complexContent, simpleContent, complexType...
            collect(ch, e)


def child(el, parent):
    name = el.get("name") or (el.get("ref") or "").split(":")[-1]
    if not name:
        return
    parent["children"].add(name)
    if el.get("ref"):
        return  # defined at top level
    define(el)


def define(el):
    name = el.get("name")
    e = entry(name)
    t = (el.get("type") or "").split(":")[-1]
    if t in types:
        collect(types[t], e)
    for ct in el.findall(NS + "complexType"):
        collect(ct, e)


for el in root.findall(NS + "element"):
    define(el)

out = {k: {"attrs": sorted(v["attrs"]), "children": sorted(v["children"]), "open": v["open"]}
       for k, v in sorted(model.items())}
json.dump(out, open("src/liquibase-model.json", "w"), indent=1)
print(len(out), "elements;", "changeSet:", out.get("changeSet"))
