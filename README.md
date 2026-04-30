# Winding Trails Digital Map
Mapping the entirety of Winding Trails, one report at a time.

## Usage
Navigate to [our webpage](https://jemcats.software/websites/windingtrailsdigitalmap/index.html).

If you are on an iPhone or iPad you will have the ability to install the app to your home screen.

## Making a report
Reports can be made out to:
```
PUT https://easy-map.mattheis.ddns.net/windingtrails/makereport
```

Just add a body like:
```json
{
    "this":"is",
    "an":"example",
    "of":"a",
    "report":-1
}
```

## Tiles
This project uses custom tiles to remove pre-existing lines in OSM.

Tiles are avalible at:
```
https://easy-map.mattheis.ddns.net/maps/winding_trails/{z}/{x}/{y}.png
```

or if you are looking to self-host, you can download from this repository under ```/assets/tiles.zip```

## Contributing
Make your own fork of the ```main``` branch

Make changes to code if you need to change frontend items

Make changes to ```/assets/data.json``` based on ```/reports.json``` from the ```reports``` branch

Open a pull request to get that merged into main