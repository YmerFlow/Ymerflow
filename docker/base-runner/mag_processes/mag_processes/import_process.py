"""Import process for magnetic survey CSV data."""

from AirMagTools.magdata import MagData

from .utils import localize_urls
from .dataset_utils import write_dataset


class MagCSVImporter:
    """Import magnetic survey data from a CSV file."""

    @classmethod
    def schema(cls):
        """Return JSON Schema for import parameters."""
        return {
            "type": "object",
            "title": "Import Magnetic (CSV)",
            "description": "Import a magnetic survey from a CSV file, attaching an EPSG coordinate "
                           "reference system. Produces a MagData dataset ready for processing.",
            "properties": {
                "csvfile": {
                    "type": "string",
                    "format": "uri",
                    "x-format": "upload",
                    "x-url-media-type": "text/csv",
                    "title": "CSV Data File",
                    "description": "Magnetic survey data in CSV format",
                    "pattern": "\\.csv(\\.gz|\\.bz2|\\.zip)?$",
                },
                "crs": {
                    "type": "integer",
                    "title": "EPSG CRS Code",
                    "description": "EPSG code for the coordinate reference system of the survey locations",
                    "format": "x-epsg",
                    "minimum": 1,
                },
            },
            "required": ["csvfile", "crs"],
        }

    @classmethod
    def run(cls, storage_context=None, **kwargs):
        """Import CSV data, attach CRS metadata, and save as msgpack.

        MagData.load() handles CSV parsing (column normalisation via
        loader.parse), sets the line/fidcount index, and merges any extra
        keyword arguments into the metadata dict — so the ``crs`` value
        ends up in ``data.meta["crs"]`` automatically.

        Args:
            storage_context: Dict with process_id, storage_base, storage_kwargs
            **kwargs: Validated schema parameters (csvfile, crs)

        Returns:
            Dict with status and outputs mapping
        """
        print("Running mag import...")

        if not storage_context:
            raise ValueError("storage_context is required")

        process_id = storage_context["process_id"]
        process_version = storage_context["version"]
        storage_base = storage_context["storage_base"]
        storage_kwargs = storage_context["storage_kwargs"]

        csvfile = kwargs.get("csvfile")
        crs = kwargs.get("crs")

        assert csvfile is not None, "Missing CSV file"
        assert isinstance(crs, int) and crs > 0, \
            "Invalid CRS: please provide a valid EPSG code"

        with localize_urls({"csvfile": csvfile}, storage_kwargs) as localized:
            print(f"Loading CSV: {localized['csvfile']}")
            data = MagData.load(localized["csvfile"], crs=crs)

            print("Writing imported dataset...")
            dataset_id = write_dataset(
                data,
                "imported_mag_data",
                process_id,
                process_version,
                storage_base,
                storage_kwargs,
            )

        outputs = {
            "imported_data": f"{storage_base}/processes/{process_id}/{process_version}/datasets/{dataset_id}/root.msgpack"
        }

        print("Mag import complete")
        return {"status": "success", "outputs": outputs}
