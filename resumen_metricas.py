#!/usr/bin/env python3
"""
Calcula las dos métricas del acta a partir del registro:
  1) Reducción de tiempo (manual vs. automático), meta >= 50 %.
  2) Tasa de aprobación sin ajuste manual por pieza (meta: >= 3 de 4 formatos).

Uso:
  python resumen_metricas.py --manual "pieza1=15,pieza2=18,pieza3=20" [--registro registro]

Los tiempos manuales van en MINUTOS y se cronometran haciendo la tarea a mano
(Canva/Photoshop) con las mismas piezas.
"""
import argparse
import csv
from collections import defaultdict
from pathlib import Path


def leer(ruta):
    with open(ruta, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registro", default="registro")
    ap.add_argument("--manual", required=True,
                    help='Tiempos manuales en minutos: "pieza=min,pieza=min"')
    args = ap.parse_args()

    reg = Path(args.registro)
    manual = {k.strip(): float(v) for k, v in (p.split("=") for p in args.manual.split(","))}

    # Última fila por pieza (si se repitió una prueba)
    tiempos = {r["pieza"]: r for r in leer(reg / "tiempos_piezas.csv")}
    metricas = defaultdict(dict)
    for r in leer(reg / "metricas_formatos.csv"):
        metricas[r["pieza"]][r["formato"]] = r["estado_revision"]

    print(f"{'pieza':<22}{'manual (min)':>13}{'auto+rev (min)':>16}{'reducción':>11}{'sin ajuste':>12}  cumple")
    tot_m = tot_a = 0.0
    piezas_ok = 0
    for pieza, t_man in manual.items():
        if pieza not in tiempos:
            print(f"{pieza:<22}  (sin registro automático)")
            continue
        t_aut = float(tiempos[pieza]["tiempo_total_s"]) / 60
        red = 1 - t_aut / t_man
        ap_ok = sum(v == "aprobado_sin_ajuste" for v in metricas[pieza].values())
        cumple_aprob = ap_ok >= 3
        piezas_ok += cumple_aprob
        tot_m += t_man
        tot_a += t_aut
        print(f"{pieza:<22}{t_man:>13.1f}{t_aut:>16.2f}{red:>10.0%}{ap_ok:>9}/4  "
              f"{'sí' if cumple_aprob else 'no'}")

    if tot_m:
        red_total = 1 - tot_a / tot_m
        print(f"\nReducción total de tiempo: {red_total:.0%} (meta ≥ 50 %): "
              f"{'CUMPLE' if red_total >= 0.5 else 'NO CUMPLE'}")
        print(f"Piezas con ≥3 de 4 formatos aprobados sin ajuste: {piezas_ok}/{len(manual)}")
        print("Nota: la aprobación solo es válida si se usó --revisar (revisión humana real).")


if __name__ == "__main__":
    main()
