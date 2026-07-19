// :shortcode: table + pure scan logic — ported from ui/emoji.js. The scan is
// pure (text, cursor) → result so the composer stays in charge of its own
// value/selection; the autocomplete widget just renders matches.
//
// Port fix: the old inline-complete check did lastIndexOf(':') on text that
// already contained the just-typed closing colon, so the fragment was always
// empty and direct :code:→emoji replacement never fired (only the popup path
// worked). Here the opening colon is searched before the closing one.
export const EMOJI_SHORTCODES: Record<string, string> = {
  'smile': '😄', 'grin': '😀', 'grinning': '😀', 'laugh': '😂', 'joy': '😂',
  'rofl': '🤣', 'smiley': '😃', 'wink': '😉', 'blush': '😊', 'innocent': '😇',
  'heart_eyes': '😍', 'star_struck': '🤩', 'kissing': '😘', 'kissing_heart': '😘',
  'yum': '😋', 'stuck_out_tongue': '😛', 'stuck_out_tongue_winking_eye': '😜',
  'zany': '🤪', 'crazy': '🤪', 'thinking': '🤔', 'think': '🤔', 'hmm': '🤔',
  'shush': '🤫', 'zipper_mouth': '🤐', 'raised_eyebrow': '🤨',
  'neutral': '😐', 'expressionless': '😑', 'no_mouth': '😶',
  'smirk': '😏', 'unamused': '😒', 'roll_eyes': '🙄', 'grimace': '😬',
  'lying': '🤥', 'relieved': '😌', 'pensive': '😔', 'sleepy': '😪',
  'drool': '🤤', 'sleeping': '😴', 'mask': '😷', 'nerd': '🤓',
  'sunglasses': '😎', 'cool': '😎', 'confused': '😕', 'worried': '😟',
  'frown': '☹️', 'open_mouth': '😮', 'hushed': '😯', 'astonished': '😲',
  'flushed': '😳', 'pleading': '🥺', 'cry': '😢', 'sob': '😭',
  'scream': '😱', 'angry': '😠', 'rage': '😡', 'swear': '🤬',
  'devil': '😈', 'imp': '👿', 'skull': '💀', 'poop': '💩', 'poo': '💩',
  'clown': '🤡', 'ghost': '👻', 'alien': '👽', 'robot': '🤖',
  'heart': '❤️', 'red_heart': '❤️', 'orange_heart': '🧡',
  'yellow_heart': '💛', 'green_heart': '💚', 'blue_heart': '💙',
  'purple_heart': '💜', 'black_heart': '🖤', 'white_heart': '🤍',
  'broken_heart': '💔', 'fire': '🔥', 'flame': '🔥',
  '100': '💯', 'hundred': '💯', 'boom': '💥', 'collision': '💥',
  'star': '⭐', 'star2': '🌟', 'sparkles': '✨', 'sparkle': '✨',
  'zap': '⚡', 'lightning': '⚡', 'bolt': '⚡',
  'wave': '👋', 'hi': '👋', 'hello': '👋', 'bye': '👋',
  'ok_hand': '👌', 'ok': '👌', 'pinch': '🤏',
  'v': '✌️', 'peace': '✌️', 'fingers_crossed': '🤞',
  'metal': '🤘', 'rock': '🤘', 'call_me': '🤙',
  'point_up': '☝️', 'point_down': '👇', 'point_left': '👈', 'point_right': '👉',
  'thumbsup': '👍', 'thumbup': '👍', '+1': '👍', 'up': '👍',
  'thumbsdown': '👎', 'thumbdown': '👎', '-1': '👎', 'down': '👎',
  'fist': '✊', 'punch': '👊', 'clap': '👏', 'raised_hands': '🙌',
  'handshake': '🤝', 'pray': '🙏', 'muscle': '💪', 'flex': '💪',
  'eyes': '👀', 'eye': '👁️', 'brain': '🧠', 'tongue': '👅',
  'baby': '👶', 'man': '👨', 'woman': '👩', 'person': '🧑',
  'shrug': '🤷', 'facepalm': '🤦', 'bow': '🙇',
  'dog': '🐶', 'cat': '🐱', 'mouse': '🐭', 'hamster': '🐹',
  'rabbit': '🐰', 'fox': '🦊', 'bear': '🐻', 'panda': '🐼',
  'koala': '🐨', 'tiger': '🐯', 'lion': '🦁', 'cow': '🐮',
  'pig': '🐷', 'monkey': '🐵', 'chicken': '🐔', 'penguin': '🐧',
  'bird': '🐦', 'eagle': '🦅', 'frog': '🐸', 'snake': '🐍',
  'dragon': '🐉', 'unicorn': '🦄', 'bee': '🐝', 'bug': '🐛',
  'butterfly': '🦋', 'turtle': '🐢', 'octopus': '🐙',
  'fish': '🐟', 'shark': '🦈', 'whale': '🐳', 'dolphin': '🐬',
  'crab': '🦀', 'lobster': '🦞', 'shrimp': '🦐',
  'rose': '🌹', 'sunflower': '🌻', 'tulip': '🌷', 'cherry_blossom': '🌸',
  'tree': '🌳', 'palm': '🌴', 'cactus': '🌵', 'leaf': '🍃',
  'clover': '🍀', 'four_leaf_clover': '🍀', 'mushroom': '🍄',
  'apple': '🍎', 'green_apple': '🍏', 'banana': '🍌', 'grapes': '🍇',
  'watermelon': '🍉', 'strawberry': '🍓', 'peach': '🍑', 'cherry': '🍒',
  'pizza': '🍕', 'burger': '🍔', 'fries': '🍟', 'hotdog': '🌭',
  'taco': '🌮', 'burrito': '🌯', 'egg': '🍳', 'cookie': '🍪',
  'cake': '🎂', 'pie': '🥧', 'chocolate': '🍫', 'candy': '🍬',
  'lollipop': '🍭', 'ice_cream': '🍦', 'donut': '🍩', 'doughnut': '🍩',
  'coffee': '☕', 'tea': '🍵', 'beer': '🍺', 'beers': '🍻',
  'wine': '🍷', 'cocktail': '🍸', 'champagne': '🥂',
  'sun': '☀️', 'sunny': '☀️', 'moon': '🌙', 'cloud': '☁️',
  'rain': '🌧️', 'snow': '❄️', 'snowflake': '❄️', 'rainbow': '🌈',
  'umbrella': '☂️', 'ocean': '🌊', 'earth': '🌍', 'globe': '🌐',
  'rocket': '🚀', 'airplane': '✈️', 'plane': '✈️', 'car': '🚗',
  'bus': '🚌', 'train': '🚆', 'bike': '🚲', 'ship': '🚢',
  'house': '🏠', 'office': '🏢', 'hospital': '🏥', 'school': '🏫',
  'church': '⛪', 'castle': '🏰', 'tent': '⛺',
  'trophy': '🏆', 'medal': '🏅', 'first_place': '🥇', 'second_place': '🥈',
  'third_place': '🥉', 'soccer': '⚽', 'basketball': '🏀', 'football': '🏈',
  'baseball': '⚾', 'tennis': '🎾', 'golf': '⛳',
  'video_game': '🎮', 'joystick': '🕹️', 'game': '🎮',
  'art': '🎨', 'paint': '🎨', 'music': '🎵', 'notes': '🎶',
  'mic': '🎤', 'headphones': '🎧', 'guitar': '🎸', 'piano': '🎹',
  'drum': '🥁', 'movie': '🎬', 'camera': '📷',
  'computer': '💻', 'laptop': '💻', 'desktop': '🖥️',
  'phone': '📱', 'telephone': '☎️', 'email': '📧', 'mail': '📧',
  'envelope': '✉️', 'package': '📦', 'inbox': '📥', 'outbox': '📤',
  'memo': '📝', 'note': '📝', 'pencil': '✏️', 'pen': '🖊️',
  'book': '📖', 'books': '📚', 'notebook': '📓',
  'clipboard': '📋', 'calendar': '📅', 'chart': '📊',
  'graph': '📈', 'chart_down': '📉', 'folder': '📁',
  'paperclip': '📎', 'clip': '📎', 'pin': '📌', 'pushpin': '📌',
  'lock': '🔒', 'unlock': '🔓', 'key': '🔑',
  'hammer': '🔨', 'wrench': '🔧', 'screwdriver': '🪛',
  'gear': '⚙️', 'cog': '⚙️', 'link': '🔗', 'chain': '⛓️',
  'bulb': '💡', 'lightbulb': '💡', 'flashlight': '🔦',
  'bomb': '💣', 'gun': '🔫', 'shield': '🛡️',
  'gem': '💎', 'diamond': '💎', 'money': '💰', 'dollar': '💵',
  'credit_card': '💳', 'moneybag': '💰',
  'hourglass': '⏳', 'timer': '⏱️', 'alarm': '⏰', 'clock': '🕐',
  'magnifying_glass': '🔍', 'search': '🔍',
  'bell': '🔔', 'megaphone': '📢', 'loudspeaker': '📢',
  'check': '✅', 'checkmark': '✅', 'white_check_mark': '✅',
  'x': '❌', 'cross': '❌', 'no': '❌',
  'warning': '⚠️', 'caution': '⚠️',
  'question': '❓', 'exclamation': '❗',
  'recycle': '♻️', 'atom': '⚛️',
  'flag': '🏳️', 'pirate': '🏴‍☠️',
  'party': '🎉', 'tada': '🎉', 'confetti': '🎊',
  'balloon': '🎈', 'gift': '🎁', 'present': '🎁',
  'fireworks': '🎆', 'sparkler': '🎇',
  'ribbon': '🎀', 'crown': '👑', 'ring': '💍',
  'lipstick': '💄', 'kiss': '💋', 'lips': '👄',
  'sweat': '😓', 'sweat_smile': '😅', 'cold_sweat': '😰',
  'dizzy': '😵', 'exploding_head': '🤯', 'cowboy': '🤠',
  'partying': '🥳', 'disguised': '🥸',
  'monocle': '🧐', 'upside_down': '🙃', 'melting': '🫠',
  'salute': '🫡', 'dotted_line': '🫥', 'peeking': '🫣',
  'hand_over_mouth': '🤭', 'yawn': '🥱', 'hug': '🤗',
  'see_no_evil': '🙈', 'hear_no_evil': '🙉', 'speak_no_evil': '🙊',
  'tm': '™️', 'copyright': '©️', 'registered': '®️',
  'info': 'ℹ️', 'abc': '🔤', 'abcd': '🔡',
  'sos': '🆘', 'new': '🆕', 'free': '🆓', 'top': '🔝',
  'end': '🔚', 'back': '🔙', 'on': '🔛', 'soon': '🔜',
  'zzz': '💤', 'speech': '💬', 'thought': '💭',
  'left_right': '↔️', 'up_down': '↕️',
  'arrow_up': '⬆️', 'arrow_down': '⬇️', 'arrow_left': '⬅️', 'arrow_right': '➡️',
};

export interface ShortcodeMatch {
  name: string;
  emoji: string;
}

export type ShortcodeScan =
  | { kind: 'none' }
  | { kind: 'complete'; text: string; cursor: number }
  | { kind: 'suggest'; matches: ShortcodeMatch[]; colonIdx: number };

export function scanShortcode(text: string, pos: number): ShortcodeScan {
  const before = text.slice(0, pos);

  // Just typed the closing ':' of a full :code: → replace it inline.
  if (text[pos - 1] === ':') {
    const openIdx = before.lastIndexOf(':', pos - 2);
    if (openIdx !== -1) {
      const code = before.slice(openIdx + 1, pos - 1).toLowerCase();
      const emoji = code && !code.includes(' ') ? EMOJI_SHORTCODES[code] : undefined;
      if (emoji) {
        return {
          kind: 'complete',
          text: text.slice(0, openIdx) + emoji + text.slice(pos),
          cursor: openIdx + emoji.length,
        };
      }
    }
    return { kind: 'none' };
  }

  const colonIdx = before.lastIndexOf(':');
  if (colonIdx === -1) return { kind: 'none' };
  const fragment = before.slice(colonIdx + 1);

  // ≥2 chars to start suggesting; a space means it wasn't a shortcode.
  if (fragment.length < 2 || fragment.includes(' ')) return { kind: 'none' };

  const query = fragment.toLowerCase();
  const matches: Array<ShortcodeMatch & { exact: boolean }> = [];
  for (const [name, emoji] of Object.entries(EMOJI_SHORTCODES)) {
    if (name.startsWith(query) || name.includes(query)) {
      matches.push({ name, emoji, exact: name.startsWith(query) });
    }
    if (matches.length >= 8) break;
  }
  matches.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));

  if (matches.length === 0) return { kind: 'none' };
  return { kind: 'suggest', matches, colonIdx };
}
