import pytest

from recap.numbers import amount_variants, find_amount_tokens, looks_like_amount, normalize_pct, parse_amount


@pytest.mark.parametrize(
    "tok,val",
    [
        ("1,234", 1234),
        ("1234", 1234),
        ("$1,234", 1234),
        ("(1,234)", -1234),
        ("1,234-", -1234),
        ("-1,234", -1234),
        ("0", 0),
        ("-", 0),
        ("-0-", 0),
        ("12.49", 12),
        ("12.50", 13),
        ("abc", None),
        ("2b", None),
    ],
)
def test_parse_amount(tok, val):
    assert parse_amount(tok) == val


def test_variants_and_tokens():
    assert "$84,250" in amount_variants(84250)
    assert "(3,000)" in amount_variants(-3000)
    toks = find_amount_tokens("Your income was $84,250 and tax 12,345; the rate was 14.6% not 14.6")
    assert (" $84,250".strip(), 84250) in toks
    assert ("12,345", 12345) in toks
    assert all(v != 14 for _, v in toks if _.startswith("14.6%"))
    assert looks_like_amount("(12)") and not looks_like_amount("-")
    assert normalize_pct("14.6%") == pytest.approx(0.146)
