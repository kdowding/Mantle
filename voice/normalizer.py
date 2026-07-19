"""
Text normalization for Chatterbox-Turbo TTS input.

The model is fed at the boundary between the agent's natural-language output
and the acoustic decoder. A handful of input shapes cause audible artifacts
(double quotes → "sigh", ellipsis → comma-collapse, unsupported [tags] →
vocalized as words, short fragments → hallucinations). The voice-mode system
prompt asks the agent to avoid most of these proactively, but this module is
the defensive backstop — it ensures Chatterbox compliance regardless of what
slips through.

Pipeline runs BEFORE punc_norm() (called inside chatterbox internally) so
characters that punc_norm would introduce (e.g. straight quotes from curly
quote conversion) are stripped here first.

Known artifact triggers (mitigated below):
- Double quotes (straight + curly) → ~1.2s "sigh" sound
- Ellipsis "..."  → punc_norm converts to ", " killing hesitation prosody
- Markdown syntax (**, *, #, `, |, -)  → gibberish or skipped
- Emoji + non-printable unicode  → unpredictable vocalization
- URLs read aloud  → character-by-character or skipped
- Code blocks  → out-of-distribution tokens
- Unsupported [bracket] tags (e.g. [pause], [whisper])  → spoken as words
- Short segments (< 20 chars)  → model hallucinations
- Inline reference numbers after punctuation (".3", ".188")  → read aloud
"""

import re
import unicodedata
from typing import List


# ── Compiled patterns (built once at import) ───────────────────────────────

_RE_CODE_FENCE = re.compile(r'```[\s\S]*?```', re.MULTILINE)
_RE_INLINE_CODE = re.compile(r'`([^`\n]*)`')
_RE_BOLD_ITALIC = re.compile(r'\*{1,3}([^\*\n]*)\*{1,3}|_{1,3}([^_\n]*)_{1,3}')
_RE_HEADERS = re.compile(r'^#{1,6}\s+', re.MULTILINE)
_RE_MD_LINK = re.compile(r'\[([^\]]*)\]\([^\)]*\)')
_RE_URL = re.compile(r'https?://\S+|www\.\S+')
_RE_HTML = re.compile(r'<[^>]+>')
_RE_BULLET = re.compile(r'^[\-\*\+]\s+', re.MULTILINE)
_RE_NUMBERED = re.compile(r'^\d+\.\s+', re.MULTILINE)
_RE_TABLE_PIPE = re.compile(r'\|')
_RE_DOUBLE_QUOTES = re.compile(r'["“”]')
_RE_SMART_SINGLE_QUOTES = re.compile(r'[‘’‚‛]')         # curly + low single quotes → straight
_RE_ELLIPSIS = re.compile(r'\.{3,}|…')
_RE_PARA_BREAK = re.compile(r'\n{2,}')
_RE_MULTI_PERIOD = re.compile(r'\.{2,}')
_RE_REPEAT_BANG = re.compile(r'!{2,}')
_RE_REPEAT_QUESTION = re.compile(r'\?{2,}')
_RE_HR = re.compile(r'^\s*[-\*_]{3,}\s*$', re.MULTILINE)
_RE_INLINE_REF = re.compile(r'(?<=[.!?])["\']?\d+')
_RE_MULTI_SPACE = re.compile(r' {2,}')
_RE_BRACKET_TAG = re.compile(r'\[(\w[\w\s]*)\]')
_RE_SENTENCE_SPLIT = re.compile(r'(?<=[.!?])\s+')

# Em-dash + en-dash → comma. Chatterbox derails on these — observed in logs
# as cap-hit runaway on chunks containing —. Speech-wise an em-dash and a
# comma render almost identically (brief pause), so this is a safe swap.
_RE_DASH = re.compile(r'\s*[—–]\s*')

# Standalone "gibberish" symbols that aren't part of structures already
# handled (URLs, code, brackets, MD links). These tokens confuse the
# acoustic decoder when they leak through. Strip them.
_RE_GIBBERISH_SYMBOLS = re.compile(r'[@#&*+=~^|<>{}\[\]\\/]')

# Repeated identical chars 6+ in a row ("hmmmmmm", "noooooo"). Chatterbox
# can loop on long runs, triggering runaway. Cap at 3 — preserves natural
# emphasis ("hmm", "Zzzz", "ohhh") and only kicks in for clearly excessive
# runs that wouldn't reflect natural pronunciation anyway.
_RE_REPEATED_CHARS = re.compile(r'(\w)\1{5,}', re.IGNORECASE)

# Currency / percent / ampersand expansion. Numbers passed verbatim, but the
# symbol gets read as a word so the model speaks naturally.
_RE_DOLLAR_AMOUNT = re.compile(r'\$(\d+(?:\.\d+)?)')
_RE_PERCENT_AMOUNT = re.compile(r'(\d+(?:\.\d+)?)\s*%')
_RE_AMPERSAND_WORD = re.compile(r'\s+&\s+')

# Underscore-laden identifiers (some_var_name, do_something). Replace
# underscores with spaces so the model reads it as separate words rather
# than one mash.
_RE_UNDERSCORE_IDENT = re.compile(r'(?<=\w)_(?=\w)')

# All-caps acronyms. Short (2-3 chars) get spelled out letter-by-letter
# ("AI" → "A I" → "ay-eye"); longer (4+) get title-cased so they read as
# a word ("MANTLE" → "Mantle"). Allowlist keeps short common-word forms
# ("OK", "AM", "PM") as they're already pronounced as words.
_RE_ALL_CAPS = re.compile(r'\b[A-Z]{2,}\b')
_ACRONYM_KEEP_AS_WORD = frozenset({'OK', 'AM', 'PM'})


# ── Paralinguistic tag allow-list ──────────────────────────────────────────
# Empirically, Chatterbox-Turbo vocalizes [chuckle], [laugh], etc. as the
# literal words rather than rendering them as paralinguistic sounds — so
# every bracket tag now gets stripped. The override map and emoji→tag map
# below remain intact (their output passes through _sanitize_bracket_tags
# and ends up stripped) so re-enabling tag support is a one-line revert
# if a future Chatterbox release honors them.
_VALID_TAGS: frozenset = frozenset()

_TAG_OVERRIDES = {
    # → [laugh]
    'howling': 'laugh', 'cackling': 'laugh', 'hysterical': 'laugh',
    'roaring': 'laugh', 'cracking up': 'laugh', 'burst': 'laugh',
    # → [chuckle]
    'giggle': 'chuckle', 'snicker': 'chuckle', 'titter': 'chuckle',
    'smirk': 'chuckle', 'amused': 'chuckle', 'grin': 'chuckle',
    # → [sigh]
    'exhale': 'sigh', 'whimper': 'sigh', 'sob': 'sigh',
    'crying': 'sigh', 'weeping': 'sigh', 'deflate': 'sigh',
    # → [gasp]
    'shocked': 'gasp', 'startled': 'gasp', 'surprised': 'gasp',
    'inhale': 'gasp', 'stunned': 'gasp',
    # → [groan]
    'moan': 'groan', 'grunt': 'groan', 'scoff': 'groan',
    'huff': 'groan', 'ugh': 'groan', 'grumble': 'groan',
    # → [cough]
    'clearing': 'cough', 'hack': 'cough', 'ahem': 'cough',
    # → [sniff]
    'sniffling': 'sniff', 'sniffle': 'sniff',
}

# Sorted by descending length so multi-word tags ("clear throat") are matched
# before single-word ("clear") in keyword fallback.
_VALID_TAGS_SORTED: list = sorted(_VALID_TAGS, key=len, reverse=True)


# ── Emoji → tag mapping ────────────────────────────────────────────────────
# Common emojis become paralinguistic tags BEFORE the strip pass so
# expressive intent survives. Unmapped emojis are stripped later.

_EMOJI_TAG_MAP = {
    '\U0001f602': '[laugh]',   # 😂
    '\U0001f923': '[laugh]',   # 🤣
    '\U0001f600': '[chuckle]', # 😀
    '\U0001f601': '[chuckle]', # 😁
    '\U0001f606': '[chuckle]', # 😆
    '\U0001f642': '[chuckle]', # 🙂
    '\U0001f609': '[chuckle]', # 😉
    '\U0001f631': '[gasp]',    # 😱
    '\U0001f628': '[gasp]',    # 😨
    '\U0001f62e': '[gasp]',    # 😮
    '\U0001f632': '[gasp]',    # 😲
    '\U0001f629': '[groan]',   # 😩
    '\U0001f624': '[groan]',   # 😤
    '\U0001f621': '[groan]',   # 😡
    '\U0001f614': '[sigh]',    # 😔
    '\U0001f61e': '[sigh]',    # 😞
    '\U0001f625': '[sigh]',    # 😥
    '\U0001f622': '[sigh]',    # 😢
}


# Chatterbox reliably hallucinates on inputs below this length. Pad with a
# neutral phrase that won't be audible if callers trim trailing silence.
_MIN_SAFE_CHARS = 20
_SHORT_SEGMENT_PAD = "Go ahead."


# ── Internal helpers ───────────────────────────────────────────────────────

def _map_emojis(text: str) -> str:
    for emoji, tag in _EMOJI_TAG_MAP.items():
        if emoji in text:
            text = text.replace(emoji, f' {tag} ')
    return text


def _strip_emojis(text: str) -> str:
    """Remove remaining emoji + non-text unicode. Keeps ASCII intact, drops
    Other-Symbol / Format / Surrogate / Private-Use categories plus the
    Pictographs and Dingbats blocks explicitly."""
    result = []
    for ch in text:
        cp = ord(ch)
        if cp < 128:
            result.append(ch)
            continue
        cat = unicodedata.category(ch)
        if cat in ('So', 'Cf', 'Cs', 'Co'):
            continue
        if 0x1F300 <= cp <= 0x1FAFF:
            continue
        if 0x2700 <= cp <= 0x27BF:
            continue
        result.append(ch)
    return ''.join(result)


def _normalize_acronyms(text: str) -> str:
    """All-caps words → spell-out (≤3 chars) or title-case (≥4 chars).

    Spell-out for short acronyms reads as their natural pronunciation
    (`AI` → `A I` → "ay-eye"; `API` → `A P I` → "ay-pee-eye"). Title-case
    for longer all-caps treats them as proper nouns (`MANTLE` → `Mantle`,
    `ENGLYPH` → `Englyph`) which Chatterbox renders cleanly.

    Allowlist exempts short forms that are already pronounced as words.
    """
    def _replace(m: re.Match) -> str:
        word = m.group(0)
        if word in _ACRONYM_KEEP_AS_WORD:
            return word
        if len(word) <= 3:
            return ' '.join(word)
        return word.title()
    return _RE_ALL_CAPS.sub(_replace, text)


def _sanitize_bracket_tags(text: str) -> str:
    """Resolve [bracket tags] to confirmed paralinguistic tags or strip them.

    Order: exact match → override map → keyword-substring (multi-word first
    via _VALID_TAGS_SORTED) → strip.
    """
    def _replace(m: re.Match) -> str:
        tag_text = ' '.join(m.group(1).lower().split())

        if tag_text in _VALID_TAGS:
            return m.group(0)

        for word, target in _TAG_OVERRIDES.items():
            if word in tag_text:
                return f'[{target}]'

        for valid in _VALID_TAGS_SORTED:
            if valid in tag_text:
                return f'[{valid}]'

        return ''

    return _RE_BRACKET_TAG.sub(_replace, text)


# ── Public API ─────────────────────────────────────────────────────────────

def normalize_for_tts(text: str) -> str:
    """Clean text so it's safe to pass to Chatterbox-Turbo.

    Strips markdown formatting, code blocks, URLs, double quotes (artifact
    trigger), emojis, unsupported tags, and other non-speech unicode.
    Preserves valid paralinguistic tags, punctuation, contractions, and
    natural sentence structure.

    Call BEFORE chunking and BEFORE the synthesis call.
    """
    if not text or not text.strip():
        return text

    text = _RE_CODE_FENCE.sub('', text)
    text = _RE_INLINE_CODE.sub(r'\1', text)
    # Underscore identifiers BEFORE bold/italic — markdown italic uses
    # `_word_` syntax, but `some_var_name` would also get eaten by that
    # regex if we let it run first. Splitting `_` between word chars to
    # spaces preempts the markdown match without affecting `_italic_`.
    text = _RE_UNDERSCORE_IDENT.sub(' ', text)
    text = _RE_BOLD_ITALIC.sub(lambda m: m.group(1) or m.group(2) or '', text)
    text = _RE_HEADERS.sub('', text)
    text = _RE_MD_LINK.sub(r'\1', text)        # before _RE_URL: link's URL goes with the link
    text = _RE_URL.sub('', text)
    text = _RE_HTML.sub('', text)
    text = _RE_HR.sub('', text)
    text = _RE_BULLET.sub('', text)
    text = _RE_NUMBERED.sub('', text)
    text = _RE_TABLE_PIPE.sub(' ', text)
    text = _RE_DOUBLE_QUOTES.sub('', text)     # before punc_norm rewrites curly→straight
    text = _RE_SMART_SINGLE_QUOTES.sub("'", text)  # curly singles → straight (preserves contractions)
    text = _RE_DASH.sub(', ', text)            # em/en dash → comma; known runaway trigger
    text = _RE_ELLIPSIS.sub('. ', text)        # before punc_norm collapses to ", "
    text = _map_emojis(text)                   # before _strip_emojis kills them
    text = _strip_emojis(text)
    text = _sanitize_bracket_tags(text)
    # Currency / percent / ampersand BEFORE the gibberish-symbol strip so $%& aren't lost
    text = _RE_DOLLAR_AMOUNT.sub(r'\1 dollars', text)
    text = _RE_PERCENT_AMOUNT.sub(r'\1 percent', text)
    text = _RE_AMPERSAND_WORD.sub(' and ', text)
    text = _RE_GIBBERISH_SYMBOLS.sub(' ', text) # leftover @#&*+=~^|<>{}[]\/ → space
    text = _RE_REPEATED_CHARS.sub(r'\1\1\1', text) # 6+ same char → cap at 3 (hmmmmmm → hmm)
    text = _normalize_acronyms(text)            # MANTLE → Mantle, AI → A I
    text = _RE_INLINE_REF.sub('', text)
    text = _RE_PARA_BREAK.sub('. ', text)
    text = _RE_MULTI_PERIOD.sub('.', text)
    text = text.replace('\n', ' ')
    text = _RE_REPEAT_BANG.sub('!', text)
    text = _RE_REPEAT_QUESTION.sub('?', text)
    text = _RE_MULTI_SPACE.sub(' ', text)

    result = text.strip()

    if 0 < len(result) < _MIN_SAFE_CHARS:
        result = result + ' ' + _SHORT_SEGMENT_PAD

    return result


def split_for_tts(text: str, min_chars: int = 60, max_chars: int = 200) -> List[str]:
    """Split text into sentence-level chunks for sequential synthesis.

    Used by the on-demand "speak this whole message" path. The streaming
    path chunks on the mantle side (TypeScript) so it can flush as soon as
    a sentence boundary lands in the LLM's output stream.

    Greedy merge: extend the current chunk until the next sentence would
    push past max_chars AND the chunk is already at least min_chars. Splits
    only at sentence-ending punctuation so words/sentences are never cut.
    """
    parts = [p.strip() for p in _RE_SENTENCE_SPLIT.split(text.strip()) if p.strip()]
    chunks: List[str] = []
    current = ""
    for sent in parts:
        if not current:
            current = sent
        elif len(current) + 1 + len(sent) <= max_chars:
            current = current + " " + sent
        elif len(current) < min_chars:
            current = current + " " + sent
        else:
            chunks.append(current)
            current = sent
    if current:
        chunks.append(current)
    return chunks or [text]
