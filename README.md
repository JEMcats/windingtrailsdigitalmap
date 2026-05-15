# Winding Trails Digital Map
Mapping the entirety of Winding Trails, one report at a time.

## Usage
Navigate to [our webpage](https://jemcats.software/websites/windingtrailsdigitalmap/index.html).

If you are on an iPhone or iPad you will have the ability to install the app to your home screen.

If you find any bugs or want something changed please make an issue in Github!

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

## Upcoming features
|Feature|Predicted Release Version|
|------|------|
|GPX route uploads|v1.1.0|
|Report section of uploaded route|v1.2.0|
|Search|v1.3.0|
|Route planning|v1.4.0|
|Turn-by-turn navigation|v1.5.0|

## Contributing
Make your own fork of the ```main``` branch

Make changes to code if you need to change frontend items (Do **NOT** make any of the features listed in Upcoming features)

Make changes to ```/assets/data.json``` based on ```/reports.json``` from the ```reports``` branch

Open a pull request to get that merged into main

## License
This project is licensed under the GPL-3.0 license.

You may:
- Modify and redistribute the code,
- Only if you keep it open-source and GPL-licensed,
- Provide credit to the original author (JEMcats).

No closed-source forks or redistributions allowed.

## Support
For questions open a discussion.

For support, reports, or requests open an issue.