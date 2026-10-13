import {SourcePersistence as BasePersistence} from './source-platform';

export const SOURCE_ENGINE='dsh-source-639ed015-resident-v2';

// Same recorded bridge schedule as v1. Only a verified checkpoint response may
// trigger release, using the batch's captured end rather than the later live tail.
export class SourcePersistence extends BasePersistence {
  constructor(ctx:any,runID:string,exchange:(frame:any)=>Promise<any>,limit?:number) {
    let session:any;
    const projections=ctx.sessionProjections;
    const meter=ctx.tokenMeter;
    // Cordis returns context-bound service wrappers; wrapper object identity is
    // not stable. Primitive tokens belong to the actual service instances.
    const projectionIdentity=projections.retentionIdentity;
    const meterIdentity=meter.retentionIdentity;
    if(typeof projectionIdentity!=='symbol'||typeof meterIdentity!=='symbol') throw new Error('resident consumer profile missing');
    super(ctx,runID,async frame=>{
      const result=await exchange(frame);
      this.assertHealthy(); // An observer can fail while the reply is in flight.
      if(frame.method==='checkpoint' && result?.persisted===true && /^[a-f0-9]{64}$/.test(result.manifest_hash)) {
        if(!session) throw new Error('resident session was not published');
        if(ctx.get('sessionProjections')?.retentionIdentity!==projectionIdentity || ctx.get('tokenMeter')?.retentionIdentity!==meterIdentity)
          throw new Error('resident consumer lifecycle changed');
        // Preparation is synchronous. All fallible consumer work precedes eviction.
        projections.prepareRetention(session);
        meter.prepareRetention(session);
        session.releaseArchived(frame.event_end);
      }
      return result;
    },limit);
    ctx.on('session/created',(created:any)=>{session=created;});
  }
}
