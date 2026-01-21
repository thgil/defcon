import { useMemo } from 'react';
import { useGameStore } from '../../../stores/gameStore';
import {
  getBuildings,
  type Building,
  type Silo,
  type Radar,
  type Airfield,
  type SatelliteLaunchFacility,
  type GeoPosition,
} from '@defcon/shared';

// Calculate great circle distance (approximate)
function greatCircleDistance(a: GeoPosition, b: GeoPosition): number {
  const R = 6371; // Earth radius in km
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;

  const aCalc =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(aCalc), Math.sqrt(1 - aCalc));

  return R * c;
}

function getBuildingName(type: string, index: number): string {
  switch (type) {
    case 'silo':
      return `SILO-${String(index + 1).padStart(2, '0')}`;
    case 'radar':
      return `RADAR-${String(index + 1).padStart(2, '0')}`;
    case 'airfield':
      return `AFB-${String(index + 1).padStart(2, '0')}`;
    case 'satellite_launch_facility':
      return `SAT-${String(index + 1).padStart(2, '0')}`;
    default:
      return `UNIT-${index + 1}`;
  }
}

interface RadarLink {
  radarName: string;
  distance: number;
}

interface SiloDisplay extends Silo {
  displayName: string;
  radarLinks: RadarLink[];
}

interface RadarDisplay extends Radar {
  displayName: string;
  trackedTargets: number;
}

interface AirfieldDisplay extends Airfield {
  displayName: string;
}

interface SatFacilityDisplay extends SatelliteLaunchFacility {
  displayName: string;
}

export default function InstallationsTab() {
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const selectBuilding = useGameStore((s) => s.selectBuilding);

  const { silos, radars, airfields, satFacilities } = useMemo(() => {
    if (!gameState || !playerId) {
      return { silos: [], radars: [], airfields: [], satFacilities: [] };
    }

    const allBuildings = getBuildings(gameState);
    const myBuildings = allBuildings.filter((b) => b.ownerId === playerId);

    // Separate by type
    const rawSilos = myBuildings.filter((b) => b.type === 'silo') as Silo[];
    const rawRadars = myBuildings.filter((b) => b.type === 'radar') as Radar[];
    const rawAirfields = myBuildings.filter(
      (b) => b.type === 'airfield'
    ) as Airfield[];
    const rawSatFacilities = myBuildings.filter(
      (b) => b.type === 'satellite_launch_facility'
    ) as SatelliteLaunchFacility[];

    // Build radar display data
    const radars: RadarDisplay[] = rawRadars.map((r, i) => ({
      ...r,
      displayName: getBuildingName('radar', i),
      trackedTargets: 0, // Could calculate from missiles in range
    }));

    // Build silo display data with radar links
    const silos: SiloDisplay[] = rawSilos.map((s, i) => {
      const radarLinks: RadarLink[] = [];

      if (s.geoPosition) {
        for (const radar of radars) {
          if (radar.geoPosition && !radar.destroyed) {
            const dist = greatCircleDistance(s.geoPosition, radar.geoPosition);
            // Consider radars within reasonable communication range
            if (dist < 2000) {
              radarLinks.push({
                radarName: radar.displayName,
                distance: Math.round(dist),
              });
            }
          }
        }
      }

      return {
        ...s,
        displayName: getBuildingName('silo', i),
        radarLinks,
      };
    });

    const airfields: AirfieldDisplay[] = rawAirfields.map((a, i) => ({
      ...a,
      displayName: getBuildingName('airfield', i),
    }));

    const satFacilities: SatFacilityDisplay[] = rawSatFacilities.map(
      (s, i) => ({
        ...s,
        displayName: getBuildingName('satellite_launch_facility', i),
      })
    );

    return { silos, radars, airfields, satFacilities };
  }, [gameState, playerId]);

  const handleClick = (building: Building) => {
    selectBuilding(building);
  };

  return (
    <div className="installations-tab">
      <div className="installations-header">
        INSTALLATION NETWORK STATUS
      </div>

      {/* SILOS */}
      <div className="installations-section">
        <div className="section-title">SILOS</div>
        {silos.length === 0 && (
          <div className="no-items">No silos deployed</div>
        )}
        {silos.map((silo) => (
          <div
            key={silo.id}
            className={`installation-item ${silo.destroyed ? 'destroyed' : ''}`}
            onClick={() => handleClick(silo)}
          >
            <div className="installation-row">
              <span className={`status-dot ${silo.destroyed ? 'red' : 'green'}`}>
                {silo.destroyed ? '○' : '●'}
              </span>
              <span className="installation-name">{silo.displayName}</span>
              <span className={`status-label ${silo.destroyed ? 'red' : 'green'}`}>
                [{silo.destroyed ? 'DESTROYED' : 'ONLINE'}]
              </span>
              {!silo.destroyed && (
                <>
                  <span className="installation-detail">
                    MODE: {silo.mode === 'icbm' ? 'ATTACK' : 'DEFEND'}
                  </span>
                  <span className="installation-detail">
                    ICBM: {silo.missileCount}/10
                  </span>
                  <span className="installation-detail">
                    INT: {silo.airDefenseAmmo}
                  </span>
                </>
              )}
            </div>
            {!silo.destroyed && silo.radarLinks.length > 0 && (
              <div className="installation-subrow">
                <span className="radar-link-icon">└─</span>
                RADAR LINK:{' '}
                {silo.radarLinks
                  .map((r) => `${r.radarName} (${r.distance}km)`)
                  .join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* RADARS */}
      <div className="installations-section">
        <div className="section-title">RADAR STATIONS</div>
        {radars.length === 0 && (
          <div className="no-items">No radars deployed</div>
        )}
        {radars.map((radar) => (
          <div
            key={radar.id}
            className={`installation-item ${radar.destroyed ? 'destroyed' : ''}`}
            onClick={() => handleClick(radar)}
          >
            <div className="installation-row">
              <span className={`status-dot ${radar.destroyed ? 'red' : 'green'}`}>
                {radar.destroyed ? '○' : '●'}
              </span>
              <span className="installation-name">{radar.displayName}</span>
              <span className={`status-label ${radar.destroyed ? 'red' : 'green'}`}>
                [{radar.destroyed ? 'DESTROYED' : 'ONLINE'}]
              </span>
              {!radar.destroyed && (
                <>
                  <span className="installation-detail">
                    RANGE: {radar.range}km
                  </span>
                  <span className="installation-detail">
                    {radar.active ? 'ACTIVE' : 'STANDBY'}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* AIRFIELDS */}
      <div className="installations-section">
        <div className="section-title">AIRFIELDS</div>
        {airfields.length === 0 && (
          <div className="no-items">No airfields deployed</div>
        )}
        {airfields.map((af) => (
          <div
            key={af.id}
            className={`installation-item ${af.destroyed ? 'destroyed' : ''}`}
            onClick={() => handleClick(af)}
          >
            <div className="installation-row">
              <span className={`status-dot ${af.destroyed ? 'red' : 'green'}`}>
                {af.destroyed ? '○' : '●'}
              </span>
              <span className="installation-name">{af.displayName}</span>
              <span className={`status-label ${af.destroyed ? 'red' : 'green'}`}>
                [{af.destroyed ? 'DESTROYED' : 'ONLINE'}]
              </span>
              {!af.destroyed && (
                <>
                  <span className="installation-detail">
                    FIGHTERS: {af.fighterCount}
                  </span>
                  <span className="installation-detail">
                    BOMBERS: {af.bomberCount}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* SATELLITE FACILITIES */}
      {satFacilities.length > 0 && (
        <div className="installations-section">
          <div className="section-title">SATELLITE FACILITIES</div>
          {satFacilities.map((sat) => (
            <div
              key={sat.id}
              className={`installation-item ${sat.destroyed ? 'destroyed' : ''}`}
              onClick={() => handleClick(sat)}
            >
              <div className="installation-row">
                <span
                  className={`status-dot ${sat.destroyed ? 'red' : 'green'}`}
                >
                  {sat.destroyed ? '○' : '●'}
                </span>
                <span className="installation-name">{sat.displayName}</span>
                <span
                  className={`status-label ${sat.destroyed ? 'red' : 'green'}`}
                >
                  [{sat.destroyed ? 'DESTROYED' : 'ONLINE'}]
                </span>
                {!sat.destroyed && (
                  <span className="installation-detail">
                    SATELLITES: {sat.satellites}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
