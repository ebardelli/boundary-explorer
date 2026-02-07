-- Run in app/maps
load spatial;

-- Bellevue
copy (
select
    * exclude geom,
    st_intersection((select geom from st_read('feeder_districts.geojson') where Name like 'Bellevue Union'), geom)
from st_read('secondary_blocks.geojson')
where
    st_intersects(
        (select geom from st_read('feeder_districts.geojson') where Name like 'Bellevue Union'),
        geom
    )
) to 'busd_blocks.geojson' (FORMAT GDAL, DRIVER 'GeoJSON')
;

-- Rincon Valley
copy (
select
    * exclude geom,
    st_intersection((select geom from st_read('feeder_districts.geojson') where Name like 'Rincon Valley%'), geom)
from st_read('secondary_blocks.geojson')
where
    st_intersects(
        (select geom from st_read('feeder_districts.geojson') where Name like 'Rincon Valley%'),
        geom
    )
) to 'rvusd_blocks.geojson' (FORMAT GDAL, DRIVER 'GeoJSON')
;