export class TrackQueue {
  constructor(random = Math.random) {
    this.random = random;
    this.items = [];
    this.order = [];
    this.position = -1;
    this.shuffle = false;
  }
  get current() { return this.items[this.order[this.position]] || null; }
  get nextTrack() { return this.items[this.order[this.position + 1]] || null; }
  shuffled(indices) {
    const result = [...indices];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  set(items, id = items[0]?.name) {
    this.items = [...items];
    const selected = this.items.findIndex(track => track.name === id);
    const index = selected >= 0 ? selected : 0;
    const indices = this.items.map((_, i) => i);
    this.order = this.shuffle && indices.length ? [index, ...this.shuffled(indices.filter(i => i !== index))] : indices;
    this.position = indices.length ? (this.shuffle ? 0 : index) : -1;
  }
  setShuffle(value) {
    const id = this.current?.name;
    this.shuffle = Boolean(value);
    this.set(this.items, id);
  }
  next() {
    if (!this.nextTrack) return null;
    this.position++;
    return this.current;
  }
  get upcoming() { return this.order.slice(this.position + 1).map(index => this.items[index]); }
  removeUpcoming(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.upcoming.length) return false;
    const [removed] = this.order.splice(this.position + 1 + index, 1);
    this.items.splice(removed, 1);
    this.order = this.order.map(value => value > removed ? value - 1 : value);
    return true;
  }
  moveUpcoming(from, to) {
    const count = this.upcoming.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= count || to >= count || from === to) return false;
    const [item] = this.order.splice(this.position + 1 + from, 1);
    this.order.splice(this.position + 1 + to, 0, item);
    return true;
  }
  previous() {
    if (!this.current) return null;
    this.position = Math.max(0, this.position - 1);
    return this.current;
  }
}
