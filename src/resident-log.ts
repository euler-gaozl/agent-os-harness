// Candidate-only storage for committed Session events. This is a resident index,
// not an archive: absolute positions never change and evicted reads fail loudly.
export class ResidentEventLog<E extends {seq:number; type:string; data:any}> {
  private entries = new Map<number,{event:E; bytes:number}>();
  private cursor = 0;
  private bytes = 0;
  private released = 0;
  private watermark = 0;
  private failure: Error | undefined;
  latestHeader: number | undefined;
  private control: {openTurn:number|null; unmatchedCompactionStart:E|undefined; latestEndSeedSeq:number|undefined} =
    {openTurn:null,unmatchedCompactionStart:undefined,latestEndSeedSeq:undefined};
  constructor(private maxBytes = 16 << 20, private maxEvents = 8192) {}
  get length() { return this.cursor; }
  assertHealthy() { if(this.failure) throw this.failure; }
  get(seq:number): E | undefined {
    if(!Number.isSafeInteger(seq) || seq < 0 || seq >= this.cursor) return undefined;
    const row=this.entries.get(seq);
    if(!row) throw new Error(`event ${seq} is archived; full-history reads require the authoritative archive`);
    return row.event;
  }
  at(index:number) { return this.get(index < 0 ? this.cursor+index : index); }
  slice(from=0,to=this.cursor): E[] {
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>this.cursor)
      throw new Error('invalid resident event range');
    if(to-from>this.entries.size) throw new Error('event range includes archived history');
    const result:E[]=[];
    for(let seq=from;seq<to;seq++) result.push(this.get(seq)!);
    return result;
  }
  *[Symbol.iterator]() { for(let seq=0;seq<this.cursor;seq++) yield this.get(seq)!; }
  residentEvents(): E[] { return [...this.entries.values()].map(row=>row.event); }
  push(event:E) {
    this.assertHealthy();
    if(event.seq!==this.cursor) throw new Error('resident event sequence gap');
    const size=Buffer.byteLength(JSON.stringify(event));
    if(this.bytes+size>this.maxBytes || this.entries.size>=this.maxEvents) {
      this.failure=new Error('resident history budget exceeded before archive release');
      throw this.failure;
    }
    this.entries.set(this.cursor++,{event,bytes:size}); this.bytes+=size;
    switch(event.type) {
      case 'request/header': this.latestHeader=event.seq; break;
      case 'turn/start': this.control={...this.control,openTurn:event.data.turn}; break;
      case 'turn/end': this.control={...this.control,openTurn:null}; break;
      case 'compaction/start': this.control={...this.control,unmatchedCompactionStart:event}; break;
      case 'compaction/end': this.control={...this.control,unmatchedCompactionStart:undefined}; break;
      case 'session/end-seed': this.control={...this.control,latestEndSeedSeq:event.seq}; break;
    }
  }
  compactionEntryState() { return {...this.control}; }
  release(through:number,keep:ReadonlySet<number>) {
    this.assertHealthy();
    if(!Number.isSafeInteger(through)||through<this.watermark||through>this.cursor)
      throw new Error('invalid acknowledged archive watermark');
    // Check the complete pin set before mutating anything.
    for(const seq of keep) if(this.get(seq)===undefined) throw new Error('invalid resident event pin');
    for(const [seq,row] of this.entries) {
      if(seq>=through || keep.has(seq)) continue;
      this.entries.delete(seq); this.bytes-=row.bytes; this.released++;
    }
    this.watermark=through;
  }
  stats() { return {nextSeq:this.cursor,residentEvents:this.entries.size,residentBytes:this.bytes,
    evicted:this.released,acknowledged:this.watermark,maxBytes:this.maxBytes,maxEvents:this.maxEvents}; }
}
