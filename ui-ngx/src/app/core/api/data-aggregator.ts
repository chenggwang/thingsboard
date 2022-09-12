///
/// Copyright © 2016-2022 The Thingsboard Authors
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///

import { AggKey, SubscriptionData, SubscriptionDataHolder } from '@app/shared/models/telemetry/telemetry.models';
import {
  AggregationType,
  calculateIntervalComparisonEndTime,
  calculateIntervalEndTime,
  calculateIntervalStartEndTime,
  getCurrentTime,
  getTime,
  SubscriptionTimewindow
} from '@shared/models/time/time.models';
import { UtilsService } from '@core/services/utils.service';
import { deepClone, isDefinedAndNotNull, isNumber, isNumeric } from '@core/utils';
import Timeout = NodeJS.Timeout;

export declare type onAggregatedData = (aggType: AggregationType, data: SubscriptionData, detectChanges: boolean) => void;

interface AggData {
  count: number;
  sum: number;
  aggValue: any;
}

class AggDataMap {
  rangeChanged = false;
  private minTs = Number.MAX_SAFE_INTEGER;
  private map = new Map<number, AggData>();

  set(ts: number, data: AggData) {
    if (ts < this.minTs) {
      this.rangeChanged = true;
      this.minTs = ts;
    }
    this.map.set(ts, data);
  }

  get(ts: number): AggData {
    return this.map.get(ts);
  }

  delete(ts: number) {
    this.map.delete(ts);
  }

  forEach(callback: (value: AggData, key: number, map: Map<number, AggData>) => void, thisArg?: any) {
    this.map.forEach(callback, thisArg);
  }

  size(): number {
    return this.map.size;
  }
}

class AggregationMap {
  aggMap: {[aggKey: string]: AggDataMap} = {};

  detectRangeChanged(): boolean {
    let changed = false;
    for (const aggKey of Object.keys(this.aggMap)) {
      const aggDataMap = this.aggMap[aggKey];
      if (aggDataMap.rangeChanged) {
        changed = true;
        aggDataMap.rangeChanged = false;
      }
    }
    return changed;
  }

  clearRangeChangedFlags() {
    for (const aggKey of Object.keys(this.aggMap)) {
      this.aggMap[aggKey].rangeChanged = false;
    }
  }
}

declare type AggFunction = (aggData: AggData, value?: any) => void;

const avg: AggFunction = (aggData: AggData, value?: any) => {
  aggData.count++;
  if (isNumber(value)) {
    aggData.sum = aggData.aggValue * (aggData.count - 1) + value;
    aggData.aggValue = aggData.sum / aggData.count;
  } else {
    aggData.aggValue = value;
  }
};

const min: AggFunction = (aggData: AggData, value?: any) => {
  if (isNumber(value)) {
    aggData.aggValue = Math.min(aggData.aggValue, value);
  } else {
    aggData.aggValue = value;
  }
};

const max: AggFunction = (aggData: AggData, value?: any) => {
  if (isNumber(value)) {
    aggData.aggValue = Math.max(aggData.aggValue, value);
  } else {
    aggData.aggValue = value;
  }
};

const sum: AggFunction = (aggData: AggData, value?: any) => {
  if (isNumber(value)) {
    aggData.aggValue = aggData.aggValue + value;
  } else {
    aggData.aggValue = value;
  }
};

const count: AggFunction = (aggData: AggData) => {
  aggData.count++;
  aggData.aggValue = aggData.count;
};

const none: AggFunction = (aggData: AggData, value?: any) => {
  aggData.aggValue = value;
};

export class DataAggregator {

  constructor(private onDataCb: onAggregatedData,
              private tsKeys: AggKey[],
              private isLatestDataAgg: boolean,
              private isFloatingLatestDataAgg: boolean,
              private subsTw: SubscriptionTimewindow,
              private utils: UtilsService,
              private ignoreDataUpdateOnIntervalTick: boolean) {
    this.tsKeys.forEach((key) => {
      if (!this.dataBuffer[key.agg]) {
        this.dataBuffer[key.agg] = {};
      }
      this.dataBuffer[key.agg][key.key] = [];
    });
    if (this.subsTw.aggregation.stateData) {
      this.lastPrevKvPairData = {};
    }
  }

  private dataBuffer: {[aggType: string]: SubscriptionData} = {};
  private data: {[aggType: string]: SubscriptionData};
  private readonly lastPrevKvPairData: {[aggKey: string]: [number, any]};

  private aggregationMap: AggregationMap;

  private dataReceived = false;
  private resetPending = false;
  private updatedData = false;

  private aggregationTimeout = this.isLatestDataAgg ? 1000 : Math.max(this.subsTw.aggregation.interval, 1000);

  private intervalTimeoutHandle: Timeout;
  private intervalScheduledTime: number;

  private startTs: number;
  private endTs: number;
  private elapsed: number;

  private static convertValue(val: string, noAggregation: boolean): any {
    if (val && isNumeric(val) && (!noAggregation || noAggregation && Number(val).toString() === val)) {
      return Number(val);
    }
    return val;
  }

  private static getAggFunction(aggType: AggregationType): AggFunction {
    switch (aggType) {
      case AggregationType.MIN:
        return min;
      case AggregationType.MAX:
        return max;
      case AggregationType.AVG:
        return avg;
      case AggregationType.SUM:
        return sum;
      case AggregationType.COUNT:
        return count;
      case AggregationType.NONE:
        return none;
      default:
        return avg;
    }
  }

  private static aggKeyToString(aggKey: AggKey): string {
    return `${aggKey.key}_${aggKey.agg}`;
  }

  private static aggKeyFromString(aggKeyString: string): AggKey {
    const separatorIndex = aggKeyString.lastIndexOf('_');
    const key = aggKeyString.substring(0, separatorIndex);
    const agg = AggregationType[aggKeyString.substring(separatorIndex + 1)];
    return { key, agg };
  }

  public updateOnDataCb(newOnDataCb: onAggregatedData): onAggregatedData {
    const prevOnDataCb = this.onDataCb;
    this.onDataCb = newOnDataCb;
    return prevOnDataCb;
  }

  public reset(subsTw: SubscriptionTimewindow) {
    if (this.intervalTimeoutHandle) {
      clearTimeout(this.intervalTimeoutHandle);
      this.intervalTimeoutHandle = null;
    }
    this.subsTw = subsTw;
    this.intervalScheduledTime = this.utils.currentPerfTime();
    this.calculateStartEndTs();
    this.elapsed = 0;
    this.aggregationTimeout = this.isLatestDataAgg ? 1000 : Math.max(this.subsTw.aggregation.interval, 1000);
    this.resetPending = true;
    this.updatedData = false;
    this.intervalTimeoutHandle = setTimeout(this.onInterval.bind(this), this.aggregationTimeout);
  }

  public destroy() {
    if (this.intervalTimeoutHandle) {
      clearTimeout(this.intervalTimeoutHandle);
      this.intervalTimeoutHandle = null;
    }
    this.aggregationMap = null;
  }

  public onData(aggType: AggregationType,
                data: SubscriptionDataHolder, update: boolean, history: boolean, detectChanges: boolean) {
    this.updatedData = true;
    if (!this.dataReceived || this.resetPending) {
      let updateIntervalScheduledTime = true;
      if (!this.dataReceived) {
        this.elapsed = 0;
        this.dataReceived = true;
        this.calculateStartEndTs();
      }
      if (this.resetPending) {
        this.resetPending = false;
        updateIntervalScheduledTime = false;
      }
      if (update) {
        this.aggregationMap = new AggregationMap();
        this.updateAggregatedData(aggType, data.data);
      } else {
        this.aggregationMap = this.processAggregatedData(aggType, data.data);
      }
      if (updateIntervalScheduledTime) {
        this.intervalScheduledTime = this.utils.currentPerfTime();
      }
      this.aggregationMap.clearRangeChangedFlags();
      this.onInterval(history, detectChanges);
    } else {
      this.updateAggregatedData(aggType, data.data);
      if (history) {
        this.intervalScheduledTime = this.utils.currentPerfTime();
        this.onInterval(history, detectChanges);
      } else {
        if (this.aggregationMap.detectRangeChanged()) {
          this.onInterval(false, detectChanges, true);
        }
      }
    }
  }

  private calculateStartEndTs() {
    this.startTs = this.subsTw.startTs + this.subsTw.tsOffset;
    if (this.subsTw.quickInterval) {
      if (this.subsTw.timeForComparison === 'previousInterval') {
        const startDate = getTime(this.subsTw.startTs, this.subsTw.timezone);
        const currentDate = getCurrentTime(this.subsTw.timezone);
        this.endTs = calculateIntervalComparisonEndTime(this.subsTw.quickInterval, startDate, currentDate) + this.subsTw.tsOffset;
      } else {
        const startDate = getTime(this.subsTw.startTs, this.subsTw.timezone);
        this.endTs = calculateIntervalEndTime(this.subsTw.quickInterval, startDate, this.subsTw.timezone) + this.subsTw.tsOffset;
      }
    } else {
      this.endTs = this.startTs + this.subsTw.aggregation.timeWindow;
    }
  }

  private onInterval(history?: boolean, detectChanges?: boolean, rangeChanged?: boolean) {
    const now = this.utils.currentPerfTime();
    this.elapsed += now - this.intervalScheduledTime;
    this.intervalScheduledTime = now;
    if (this.intervalTimeoutHandle) {
      clearTimeout(this.intervalTimeoutHandle);
      this.intervalTimeoutHandle = null;
    }
    const intervalTimeout = rangeChanged ? this.aggregationTimeout - this.elapsed : this.aggregationTimeout;
    if (!history) {
      const delta = Math.floor(this.elapsed / this.aggregationTimeout);
      if (delta || !this.data || rangeChanged) {
        const tickTs = delta * this.aggregationTimeout;
        if (this.subsTw.quickInterval) {
          const startEndTime = calculateIntervalStartEndTime(this.subsTw.quickInterval, this.subsTw.timezone);
          this.startTs = startEndTime[0] + this.subsTw.tsOffset;
          this.endTs = startEndTime[1] + this.subsTw.tsOffset;
        } else {
          this.startTs += tickTs;
          this.endTs += tickTs;
        }
        this.data = this.updateData();
        this.elapsed = this.elapsed - delta * this.aggregationTimeout;
      }
    } else {
      this.data = this.updateData();
    }
    if (this.onDataCb && (!this.ignoreDataUpdateOnIntervalTick || this.updatedData)) {
      for (const aggType of Object.keys(this.data)) {
        this.onDataCb(AggregationType[aggType], this.data[aggType], detectChanges);
      }
      this.updatedData = false;
    }
    if (!history) {
      this.intervalTimeoutHandle = setTimeout(this.onInterval.bind(this), intervalTimeout);
    }
  }

  private updateData(): {[aggType: string]: SubscriptionData} {
    this.dataBuffer = {};
    this.tsKeys.forEach((key) => {
      if (!this.dataBuffer[key.agg]) {
        this.dataBuffer[key.agg] = {};
      }
      this.dataBuffer[key.agg][key.key] = [];
    });
    for (const aggKeyString of Object.keys(this.aggregationMap.aggMap)) {
      const aggKeyData = this.aggregationMap.aggMap[aggKeyString];
      const aggKey = DataAggregator.aggKeyFromString(aggKeyString);
      const noAggregation = aggKey.agg === AggregationType.NONE;
      let keyData = this.dataBuffer[aggKey.agg][aggKey.key];
      aggKeyData.forEach((aggData, aggTimestamp) => {
        if (aggTimestamp < this.startTs) {
          if (this.subsTw.aggregation.stateData &&
            (!this.lastPrevKvPairData[aggKeyString] || this.lastPrevKvPairData[aggKeyString][0] < aggTimestamp)) {
            this.lastPrevKvPairData[aggKeyString] = [aggTimestamp, aggData.aggValue];
          }
          aggKeyData.delete(aggTimestamp);
          this.updatedData = true;
        } else if (aggTimestamp < this.endTs || noAggregation) {
          const kvPair: [number, any] = [aggTimestamp, aggData.aggValue];
          keyData.push(kvPair);
        }
      });
      keyData.sort((set1, set2) => set1[0] - set2[0]);
      if (this.isFloatingLatestDataAgg) {
        if (keyData.length) {
          const timestamp = this.startTs + (this.endTs - this.startTs) / 2;
          const first = keyData[0];
          const aggData: AggData = {
            aggValue: aggKey.agg === AggregationType.COUNT ? 1 : first[1],
            sum: first[1],
            count: 1
          };
          const aggFunction = DataAggregator.getAggFunction(aggKey.agg);
          for (let i = 1; i < keyData.length; i++) {
            const kvPair = keyData[i];
            aggFunction(aggData, kvPair[1]);
          }
          this.dataBuffer[aggKey.agg][aggKey.key] = [[timestamp, aggData.aggValue]];
        }
      } else {
        if (this.subsTw.aggregation.stateData) {
          this.updateStateBounds(keyData, deepClone(this.lastPrevKvPairData[aggKeyString]));
        }
        if (keyData.length > this.subsTw.aggregation.limit) {
          keyData = keyData.slice(keyData.length - this.subsTw.aggregation.limit);
        }
        this.dataBuffer[aggKey.agg][aggKey.key] = keyData;
      }
    }
    return this.dataBuffer;
  }

  private updateStateBounds(keyData: [number, any, number?][], lastPrevKvPair: [number, any]) {
    if (lastPrevKvPair) {
      lastPrevKvPair[0] = this.startTs;
    }
    let firstKvPair;
    if (!keyData.length) {
      if (lastPrevKvPair) {
        firstKvPair = lastPrevKvPair;
        keyData.push(firstKvPair);
      }
    } else {
      firstKvPair = keyData[0];
    }
    if (firstKvPair && firstKvPair[0] > this.startTs) {
      if (lastPrevKvPair) {
        keyData.unshift(lastPrevKvPair);
      }
    }
    if (keyData.length) {
      let lastKvPair = keyData[keyData.length - 1];
      if (lastKvPair[0] < this.endTs) {
        lastKvPair = deepClone(lastKvPair);
        lastKvPair[0] = this.endTs;
        keyData.push(lastKvPair);
      }
    }
  }

  private processAggregatedData(aggType: AggregationType, data: SubscriptionData): AggregationMap {
    const isCount = aggType === AggregationType.COUNT;
    const noAggregation = aggType === AggregationType.NONE || this.isFloatingLatestDataAgg;
    const aggregationMap = new AggregationMap();
    for (const key of Object.keys(data)) {
      const aggKey = DataAggregator.aggKeyToString({key, agg: aggType});
      let aggKeyData = aggregationMap.aggMap[aggKey];
      if (!aggKeyData) {
        aggKeyData = new AggDataMap();
        aggregationMap.aggMap[aggKey] = aggKeyData;
      }
      const keyData = data[key];
      keyData.forEach((kvPair) => {
        const timestamp = kvPair[0];
        const value = DataAggregator.convertValue(kvPair[1], noAggregation);
        const tsKey = timestamp;
        const aggData = {
          count: isCount ? value : isDefinedAndNotNull(kvPair[2]) ? kvPair[2] : 1,
          sum: value,
          aggValue: value
        };
        aggKeyData.set(tsKey, aggData);
      });
    }
    return aggregationMap;
  }

  private updateAggregatedData(aggType: AggregationType, data: SubscriptionData) {
    const isCount = aggType === AggregationType.COUNT;
    const noAggregation = aggType === AggregationType.NONE || this.isFloatingLatestDataAgg;
    for (const key of Object.keys(data)) {
      const aggKey = DataAggregator.aggKeyToString({key, agg: aggType});
      let aggKeyData = this.aggregationMap.aggMap[aggKey];
      if (!aggKeyData) {
        aggKeyData = new AggDataMap();
        this.aggregationMap.aggMap[aggKey] = aggKeyData;
      }
      const keyData = data[key];
      keyData.forEach((kvPair) => {
        const timestamp = kvPair[0];
        const value = DataAggregator.convertValue(kvPair[1], noAggregation);
        const aggTimestamp = noAggregation ? timestamp : (this.startTs +
          Math.floor((timestamp - this.startTs) / this.subsTw.aggregation.interval) *
          this.subsTw.aggregation.interval + this.subsTw.aggregation.interval / 2);
        let aggData = aggKeyData.get(aggTimestamp);
        if (!aggData || this.isFloatingLatestDataAgg) {
          aggData = {
            count: isDefinedAndNotNull(kvPair[2]) ? kvPair[2] : 1,
            sum: value,
            aggValue: isCount ? 1 : value
          };
          aggKeyData.set(aggTimestamp, aggData);
        } else {
          DataAggregator.getAggFunction(aggType)(aggData, value);
        }
      });
    }
  }

}
