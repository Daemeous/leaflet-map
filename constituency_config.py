"""
constituency_config.py
======================
Single source of truth for all constituency-specific settings.

HOW TO ADD A NEW CONSTITUENCY
------------------------------
1.  Add an entry to CONSTITUENCIES below.
2.  Set ACTIVE_CONSTITUENCY to your new key.
3.  Run:  python run_pipeline.py

WARD NAMES
----------
You do NOT need to worry about " Ward" suffixes.  The pipeline will try each
name with and without the suffix and accept whichever matches the GeoPackage.
Just type the ward name naturally (e.g. "Coton" or "Coton Ward" — both work).

BOUNDING BOX
------------
Format: "south, west, north, east" in decimal degrees (WGS-84).
Use https://bboxfinder.com to draw a box around your constituency.
Add a ~0.05° margin on each side to avoid clipping boundary roads.
"""

# ── Change this to switch constituency ────────────────────────────────────────
ACTIVE_CONSTITUENCY = "stone"   # key from CONSTITUENCIES dict below
# ─────────────────────────────────────────────────────────────────────────────


CONSTITUENCIES = {

    # ── Stafford Westminster Parliamentary Constituency ────────────────────────
    "stafford": {
        "display_name":   "Stafford Constituency",
        "output_prefix":  "Stafford",

        # Overpass bounding box: south, west, north, east
        "bbox": "52.69, -2.48, 53.01, -1.93",

        # Each entry: (ward_name, local_authority_district_label)
        # Ward names are matched case-insensitively against Boundary-Line;
        # the " Ward" suffix is tried automatically if the bare name fails.
        "wards": [
            ("Baswich",                    "Stafford"),
            ("Common",                     "Stafford"),
            ("Coton",                      "Stafford"),
            ("Doxey & Castletown",         "Stafford"),
            ("Eccleshall",                 "Stafford"),
            ("Forebridge",                 "Stafford"),
            ("Gnosall & Woodseaves",       "Stafford"),
            ("Highfields & Western Downs", "Stafford"),
            ("Holmcroft",                  "Stafford"),
            ("Littleworth",                "Stafford"),
            ("Loggerheads",                "Stafford"),
            ("Maer & Whitmore",            "Stafford"),
            ("Manor",                      "Stafford"),
            ("Penkside",                   "Stafford"),
            ("Rowley",                     "Stafford"),
            ("Seighford & Church Eaton",   "Stafford"),
            ("Weeping Cross & Wildwood",   "Stafford"),
        ],
    },

    # ── Stone, Great Wyrley and Penkridge Constituency ─────────────────────────
    "stone": {
        "display_name":   "Stone, Great Wyrley and Penkridge Constituency",
        "output_prefix":  "Stone",

        # Wider bbox covering South Staffordshire + Stafford Borough
        "bbox": "52.57, -2.25, 52.98, -1.85",

        "wards": [
            # South Staffordshire District (no "Ward" suffix in Boundary-Line)
            ("Brewood, Coven & Blymhill",          "South Staffordshire"),
            ("Cheslyn Hay Village",                "South Staffordshire"),
            ("Essington",                          "South Staffordshire"),
            ("Featherstone, Sharehill & Saredon", "South Staffordshire"),
            ("Great Wyrley Landywood",             "South Staffordshire"),
            ("Great Wyrley Town",                  "South Staffordshire"),
            ("Huntington & Hatherton",             "South Staffordshire"),
            ("Lapley, Stretton & Wheaton Aston",   "South Staffordshire"),
            ("Penkridge North & Acton Trussell",   "South Staffordshire"),
            ("Penkridge South & Gailey",           "South Staffordshire"),
            # Stafford Borough (has "Ward" suffix in Boundary-Line)
            ("Haywood & Hixon",                    "Stafford"),
            ("Milford",                            "Stafford"),
            ("Milwich",                            "Stafford"),
            ("St. Michael's & Stonefield",         "Stafford"),
            ("Walton",                             "Stafford"),
        ],
    },

    # ── Template for a new constituency ───────────────────────────────────────
    # "my_new_constituency": {
    #     "display_name":  "My New Constituency",
    #     "output_prefix": "MyNew",
    #     "bbox": "52.00, -2.00, 52.50, -1.50",
    #     "wards": [
    #         ("Ward One Name", "Local Authority Name"),
    #         ("Ward Two Name", "Local Authority Name"),
    #     ],
    # },

}


# ── Convenience accessors (used by run_pipeline.py) ───────────────────────────

def get_config(key=None):
    """Return the config dict for the given key (default: ACTIVE_CONSTITUENCY)."""
    k = key or ACTIVE_CONSTITUENCY
    if k not in CONSTITUENCIES:
        raise ValueError(
            f"Unknown constituency '{k}'. "
            f"Known keys: {list(CONSTITUENCIES)}"
        )
    return CONSTITUENCIES[k]
